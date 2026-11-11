// BridgeTV для iOS 9+ (armv7/arm64). Нативная оболочка для общего веб-интерфейса.
//
// Что делает нативная часть (то, чего не умеет Safari на старой iOS):
//   1. Показывает интерфейс из папки www/ внутри приложения (работает без сервера и ПК).
//   2. Мост «tv» для JavaScript (window.webkit.messageHandlers.tv):
//        fetch  — сетевые запросы через NSURLSession: без CORS и с доверием к корневым
//                 сертификатам Let's Encrypt, которых нет в iOS 9 (они лежат в certs/*.der).
//        awake  — не гасить экран, пока идёт видео.
//        open   — открыть ссылку в Safari / YouTube.
//        certs  — установить профиль сертификатов в систему (для видео и Safari):
//                 приложение на секунду поднимает мини-сервер на 127.0.0.1 и открывает Safari.
//   3. Звук видео играет даже при выключенном переключателе «без звука».
//
// Ограничения сборки под iOS 9 / armv7 (см. docs/IOS.md): не использовать @try/@catch,
// оператор % для знаковых чисел, пустые литералы @[] и @{} (символы появились в iOS 10),
// API новее iOS 9.0.
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#import <Security/Security.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>

static NSString *const kAppVersion = @"1.1.0";

// Совместимость с iOS 9: clang 11 под ARC вставляет вызов objc_unsafeClaimAutoreleasedReturnValue
// (есть в libobjc только с iOS 10), когда результат метода отбрасывается — напр. у loadFileURL/reload.
// Своя реализация: объект уже в autorelease-пуле, «забрать без удержания» = просто вернуть указатель.
// Тип void* — чтобы ARC не добавлял retain/release. Проверяется tools/check_ipa.py.
void *objc_unsafeClaimAutoreleasedReturnValue(void *obj);
void *objc_unsafeClaimAutoreleasedReturnValue(void *obj) { return obj; }

#pragma mark - Доверие к корням Let's Encrypt (ISRG X1/X2/YR/YE)

@interface TVTrust : NSObject <NSURLSessionDelegate>
+ (instancetype)shared;
@property (nonatomic, strong) NSArray *anchors;
@property (nonatomic, strong) NSURLSession *session;
@end

@implementation TVTrust
+ (instancetype)shared {
    static TVTrust *s; static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [TVTrust new]; [s setup]; });
    return s;
}
- (void)setup {
    NSMutableArray *a = [NSMutableArray array];
    NSString *dir = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"www/web/certs"];
    for (NSString *f in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil]) {
        if (![f hasSuffix:@".der"]) continue;
        NSData *d = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:f]];
        SecCertificateRef c = d ? SecCertificateCreateWithData(NULL, (__bridge CFDataRef)d) : NULL;
        if (c) { [a addObject:(__bridge_transfer id)c]; }
    }
    self.anchors = a;
    NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
    cfg.timeoutIntervalForRequest = 20;
    cfg.HTTPMaximumConnectionsPerHost = 4;
    cfg.requestCachePolicy = NSURLRequestUseProtocolCachePolicy;
    self.session = [NSURLSession sessionWithConfiguration:cfg delegate:self delegateQueue:nil];
}
// Сначала обычная проверка iOS. Если система не знает корень — проверяем ту же цепочку,
// добавив наши корни ISRG как доверенные. Посторонние/поддельные сертификаты не пропускаются.
- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)ch
 completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))done {
    if (![ch.protectionSpace.authenticationMethod isEqualToString:NSURLAuthenticationMethodServerTrust]) {
        done(NSURLSessionAuthChallengePerformDefaultHandling, nil); return;
    }
    SecTrustRef trust = ch.protectionSpace.serverTrust;
    SecTrustResultType r = kSecTrustResultInvalid;
    if (SecTrustEvaluate(trust, &r) == errSecSuccess && (r == kSecTrustResultUnspecified || r == kSecTrustResultProceed)) {
        done(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:trust]); return;
    }
    if (self.anchors.count) {
        SecTrustSetAnchorCertificates(trust, (__bridge CFArrayRef)self.anchors);
        SecTrustSetAnchorCertificatesOnly(trust, false);
        r = kSecTrustResultInvalid;
        if (SecTrustEvaluate(trust, &r) == errSecSuccess && (r == kSecTrustResultUnspecified || r == kSecTrustResultProceed)) {
            done(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:trust]); return;
        }
    }
    done(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
}
@end

#pragma mark - Мини-сервер для установки профиля сертификатов

// iOS ставит профиль (.mobileconfig) только из Safari. Приложение отдаёт файл с 127.0.0.1
// несколько раз и закрывает сокет через 60 секунд.
@interface TVProfileServer : NSObject
+ (void)serveFile:(NSString *)path open:(BOOL)open;
@end

@implementation TVProfileServer
+ (void)serveFile:(NSString *)path open:(BOOL)open {
    NSData *body = [NSData dataWithContentsOfFile:path];
    if (!body) return;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return;
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(0);                       // любой свободный порт
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(fd, 4) != 0) { close(fd); return; }
    socklen_t len = sizeof(addr);
    getsockname(fd, (struct sockaddr *)&addr, &len);
    int port = ntohs(addr.sin_port);

    UIApplication *app = [UIApplication sharedApplication];
    __block UIBackgroundTaskIdentifier bg = [app beginBackgroundTaskWithExpirationHandler:^{
        close(fd); [app endBackgroundTask:bg]; bg = UIBackgroundTaskInvalid;
    }];
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NSString *head = [NSString stringWithFormat:@"HTTP/1.0 200 OK\r\nContent-Type: application/x-apple-aspen-config\r\n"
                          "Content-Length: %lu\r\nConnection: close\r\n\r\n", (unsigned long)body.length];
        NSData *h = [head dataUsingEncoding:NSUTF8StringEncoding];
        NSDate *until = [NSDate dateWithTimeIntervalSinceNow:60];
        while ([until timeIntervalSinceNow] > 0) {
            fd_set set; FD_ZERO(&set); FD_SET(fd, &set);
            struct timeval tv; tv.tv_sec = 1; tv.tv_usec = 0;
            if (select(fd + 1, &set, NULL, NULL, &tv) <= 0) continue;
            int c = accept(fd, NULL, NULL);
            if (c < 0) break;
            char buf[2048]; recv(c, buf, sizeof(buf), 0);   // запрос не важен — отдаём файл
            send(c, h.bytes, h.length, 0);
            send(c, body.bytes, body.length, 0);
            close(c);
        }
        close(fd);
        dispatch_async(dispatch_get_main_queue(), ^{
            if (bg != UIBackgroundTaskInvalid) { [app endBackgroundTask:bg]; bg = UIBackgroundTaskInvalid; }
        });
    });
    if (open) {
        NSURL *u = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d/BridgeTV-roots.mobileconfig", port]];
        [app openURL:u];
    }
}
@end

#pragma mark - Хранилище данных (избранное, настройки, история…)

// localStorage у страниц из file:// в WKWebView на iOS 9 ненадёжен, поэтому данные хранятся
// файлами в Library/Application Support/tvstore/<ключ>.json и передаются странице при запуске.
@interface TVStoreFiles : NSObject
+ (NSString *)dir;
+ (NSString *)savedScript;
+ (void)save:(NSString *)key value:(id)value;
@end

@implementation TVStoreFiles
+ (NSString *)dir {
    static NSString *d; static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *base = [NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES) firstObject];
        d = [base stringByAppendingPathComponent:@"tvstore"];
        [[NSFileManager defaultManager] createDirectoryAtPath:d withIntermediateDirectories:YES attributes:nil error:nil];
    });
    return d;
}
+ (dispatch_queue_t)queue {
    static dispatch_queue_t q; static dispatch_once_t once;
    dispatch_once(&once, ^{ q = dispatch_queue_create("tv.store", DISPATCH_QUEUE_SERIAL); });
    return q;
}
+ (BOOL)validKey:(NSString *)k {
    if (![k isKindOfClass:[NSString class]] || k.length == 0 || k.length > 64) return NO;
    NSCharacterSet *bad = [[NSCharacterSet characterSetWithCharactersInString:
        @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"] invertedSet];
    return [k rangeOfCharacterFromSet:bad].location == NSNotFound;
}
// window.TV_SAVED = {ключ: 'JSON-строка', …};
+ (NSString *)savedScript {
    NSMutableDictionary *all = [NSMutableDictionary dictionary];
    NSString *d = [self dir];
    for (NSString *f in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:d error:nil]) {
        if (![f hasSuffix:@".json"]) continue;
        NSString *key = [f stringByDeletingPathExtension];
        NSString *v = [NSString stringWithContentsOfFile:[d stringByAppendingPathComponent:f] encoding:NSUTF8StringEncoding error:nil];
        if (v && [self validKey:key]) all[key] = v;
    }
    NSData *j = [NSJSONSerialization dataWithJSONObject:all options:0 error:nil];
    NSString *s = j ? [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding] : nil;
    return [NSString stringWithFormat:@"window.TV_SAVED=%@;", s ?: @"{}"];
}
+ (void)save:(NSString *)key value:(id)value {
    if (![self validKey:key]) return;
    NSString *path = [[self dir] stringByAppendingPathComponent:[key stringByAppendingString:@".json"]];
    dispatch_async([self queue], ^{
        if ([value isKindOfClass:[NSString class]])
            [(NSString *)value writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
        else
            [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    });
}
@end

#pragma mark - Локальный сервер: качество/озвучка YouTube и скачанные фильмы (с 0.2.4)

// Встроенный HLS-плеер iOS не даёт из JavaScript выбрать качество и озвучку. Поэтому плеер
// открывает видео YouTube через этот сервер:  http://127.0.0.1:<порт>/hls?u=<плейлист>&h=720&a=ru&s=ru
// Сервер скачивает исходный master-плейлист и отдаёт его копию, в которой:
//   • оставлены только варианты H.264 (avc1) — VP9/AV1 iPad mini 1 (A5) не декодирует;
//   • оставлено выбранное качество (h) — «Авто» (h=0): всё до 1080p;
//   • выбранная озвучка (a) и субтитры (s) помечены DEFAULT=YES;
//   • относительные ссылки превращены в абсолютные.
// Второй адрес — /file/<имя> — раздаёт скачанные фильмы с поддержкой Range (перемотка).

static NSString *TVAttr(NSString *line, NSString *name) {
    NSString *pat = [NSString stringWithFormat:@"%@=\"([^\"]*)\"", name];
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:pat options:0 error:nil];
    NSTextCheckingResult *m = [re firstMatchInString:line options:0 range:NSMakeRange(0, line.length)];
    return m ? [line substringWithRange:[m rangeAtIndex:1]] : nil;
}
static NSInteger TVHeight(NSString *line) {
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"RESOLUTION=\\d+x(\\d+)" options:0 error:nil];
    NSTextCheckingResult *m = [re firstMatchInString:line options:0 range:NSMakeRange(0, line.length)];
    return m ? [[line substringWithRange:[m rangeAtIndex:1]] integerValue] : 0;
}
static BOOL TVIsAvc(NSString *line) {
    NSString *c = TVAttr(line, @"CODECS");
    return !c || [c rangeOfString:@"avc1"].location != NSNotFound;
}
static NSString *TVSetDefault(NSString *line, BOOL on) {
    NSString *v = on ? @"DEFAULT=YES" : @"DEFAULT=NO";
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"DEFAULT=(YES|NO)" options:0 error:nil];
    if ([re numberOfMatchesInString:line options:0 range:NSMakeRange(0, line.length)])
        return [re stringByReplacingMatchesInString:line options:0 range:NSMakeRange(0, line.length) withTemplate:v];
    return [line stringByAppendingFormat:@",%@", v];
}
static NSString *TVAbsURIAttr(NSString *line, NSURL *base) {
    NSString *u = TVAttr(line, @"URI");
    if (!u) return line;
    NSString *abs = [[NSURL URLWithString:u relativeToURL:base] absoluteString] ?: u;
    return [line stringByReplacingOccurrencesOfString:[NSString stringWithFormat:@"URI=\"%@\"", u]
                                           withString:[NSString stringWithFormat:@"URI=\"%@\"", abs]];
}

static NSString *TVRewriteMaster(NSString *text, NSURL *base, NSInteger maxH, NSString *alang, NSString *slang) {
    NSArray *lines = [text componentsSeparatedByString:@"\n"];
    // 1) какое качество оставить
    NSInteger best = 0, minH = 0, cap = maxH > 0 ? maxH : 1080;
    BOOL hasAlang = NO;
    for (NSString *raw in lines) {
        NSString *l = [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if ([l hasPrefix:@"#EXT-X-STREAM-INF:"] && TVIsAvc(l)) {
            NSInteger h = TVHeight(l);
            if (h && (minH == 0 || h < minH)) minH = h;
            if (h && h <= cap && h > best) best = h;
        }
        if (alang.length && [l hasPrefix:@"#EXT-X-MEDIA:"] && [l rangeOfString:@"TYPE=AUDIO"].location != NSNotFound &&
            [[TVAttr(l, @"LANGUAGE") lowercaseString] hasPrefix:alang]) hasAlang = YES;
    }
    if (best == 0) best = minH;
    // 2) переписать
    NSMutableArray *out = [NSMutableArray array];
    BOOL skipUri = NO;
    for (NSString *raw in lines) {
        NSString *l = [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (!l.length) continue;
        if ([l hasPrefix:@"#EXT-X-I-FRAME-STREAM-INF"]) continue;
        if ([l hasPrefix:@"#EXT-X-STREAM-INF:"]) {
            NSInteger h = TVHeight(l);
            BOOL keep = TVIsAvc(l) && (!h || (maxH > 0 ? h == best : h <= best));
            if (keep) {   // ссылку на группу субтитров тоже убираем (саму группу вырезали выше)
                NSRegularExpression *sre = [NSRegularExpression regularExpressionWithPattern:@",SUBTITLES=\"[^\"]*\"" options:0 error:nil];
                [out addObject:[sre stringByReplacingMatchesInString:l options:0 range:NSMakeRange(0, l.length) withTemplate:@""]];
            }
            skipUri = !keep;
            continue;
        }
        if (![l hasPrefix:@"#"]) {
            if (!skipUri) [out addObject:[[NSURL URLWithString:l relativeToURL:base] absoluteString] ?: l];
            skipUri = NO;
            continue;
        }
        if ([l hasPrefix:@"#EXT-X-MEDIA:"]) {
            NSString *lang = [TVAttr(l, @"LANGUAGE") lowercaseString] ?: @"";
            NSString *nm = TVAttr(l, @"NAME") ?: @"";
            if ([l rangeOfString:@"TYPE=AUDIO"].location != NSNotFound) {
                BOOL on = hasAlang ? [lang hasPrefix:alang] : ([nm rangeOfString:@"original" options:NSCaseInsensitiveSearch].location != NSNotFound);
                if (hasAlang || [nm rangeOfString:@"original" options:NSCaseInsensitiveSearch].location != NSNotFound || !alang.length) l = TVSetDefault(l, on);
            } else if ([l rangeOfString:@"TYPE=SUBTITLES"].location != NSNotFound) {
                continue;   // субтитры потока через зеркало не грузятся — плеер берёт VTT из API зеркала
            }
            [out addObject:TVAbsURIAttr(l, base)];
            continue;
        }
        [out addObject:l];
    }
    return [[out componentsJoinedByString:@"\n"] stringByAppendingString:@"\n"];
}

@interface TVLocalServer : NSObject
+ (instancetype)shared;
@property (nonatomic) int port;
- (void)start;
+ (NSString *)downloadsDir;
@end

@implementation TVLocalServer {
    int _fd;
}
+ (instancetype)shared {
    static TVLocalServer *s; static dispatch_once_t once;
    dispatch_once(&once, ^{ s = [TVLocalServer new]; });
    return s;
}
+ (NSString *)downloadsDir {
    static NSString *d; static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *base = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
        d = [base stringByAppendingPathComponent:@"BridgeTV-downloads"];
        [[NSFileManager defaultManager] createDirectoryAtPath:d withIntermediateDirectories:YES attributes:nil error:nil];
        // скачанные фильмы не нужно выгружать в резервную копию iCloud/iTunes
        [[NSURL fileURLWithPath:d] setResourceValue:[NSNumber numberWithBool:YES] forKey:NSURLIsExcludedFromBackupKey error:nil];
    });
    return d;
}
// Постоянный порт из диапазона 18080–18099 (первый свободный)
- (BOOL)bindSocket {
    for (int p = 18080; p < 18100; p++) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd < 0) return NO;
        int yes = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
        struct sockaddr_in addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_port = htons((uint16_t)p);
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0 && listen(fd, 16) == 0) { _fd = fd; self.port = p; return YES; }
        close(fd);
    }
    return NO;
}
- (void)start {
    if (self.port) return;
    if (![self bindSocket]) return;
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{ [self acceptLoop]; });
}
- (void)acceptLoop {
    while (1) {
        int c = accept(_fd, NULL, NULL);
        if (c < 0) {
            // после сна iOS сокет может закрыться — поднять его заново на том же порту
            close(_fd);
            [NSThread sleepForTimeInterval:1.0];
            int keep = self.port; self.port = 0;
            if (![self bindSocket]) { self.port = keep; continue; }
            continue;
        }
        int on = 1;
        setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));   // обрыв соединения не роняет приложение
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{ [self handle:c]; });
    }
}
static BOOL TVSendAll(int c, const void *buf, size_t len) {
    const char *p = buf;
    while (len > 0) {
        ssize_t n = send(c, p, len, 0);
        if (n <= 0) return NO;
        p += n; len -= (size_t)n;
    }
    return YES;
}
- (void)reply:(int)c code:(int)code type:(NSString *)type body:(NSData *)body extra:(NSString *)extra {
    NSString *status = code == 200 ? @"OK" : code == 206 ? @"Partial Content" : code == 416 ? @"Range Not Satisfiable" : @"Not Found";
    NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %d %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\n"
                      "Access-Control-Allow-Origin: *\r\nAccept-Ranges: bytes\r\nConnection: close\r\n%@\r\n",
                      code, status, type, (unsigned long)body.length, extra ?: @""];
    NSData *h = [head dataUsingEncoding:NSUTF8StringEncoding];
    if (TVSendAll(c, h.bytes, h.length) && body.length) TVSendAll(c, body.bytes, body.length);
}
static NSString *TVQuery(NSString *query, NSString *key) {
    for (NSString *pair in [query componentsSeparatedByString:@"&"]) {
        NSRange eq = [pair rangeOfString:@"="];
        if (eq.location == NSNotFound) continue;
        if ([[pair substringToIndex:eq.location] isEqualToString:key])
            return [[[pair substringFromIndex:eq.location + 1] stringByReplacingOccurrencesOfString:@"+" withString:@" "]
                    stringByRemovingPercentEncoding] ?: @"";
    }
    return @"";
}
- (void)handle:(int)c {
    char buf[8192];
    ssize_t n = recv(c, buf, sizeof(buf) - 1, 0);
    if (n <= 0) { close(c); return; }
    buf[n] = 0;
    NSString *req = [[NSString alloc] initWithBytes:buf length:(NSUInteger)n encoding:NSUTF8StringEncoding] ?: @"";
    NSArray *first = [[[req componentsSeparatedByString:@"\r\n"] firstObject] componentsSeparatedByString:@" "];
    NSString *target = first.count > 1 ? first[1] : @"/";
    NSRange q = [target rangeOfString:@"?"];
    NSString *path = q.location == NSNotFound ? target : [target substringToIndex:q.location];
    NSString *query = q.location == NSNotFound ? @"" : [target substringFromIndex:q.location + 1];
    if ([path isEqualToString:@"/hls"]) [self serveHls:c query:query];
    else if ([path hasPrefix:@"/file/"]) [self serveFile:c name:[[path substringFromIndex:6] stringByRemovingPercentEncoding] request:req];
    else [self reply:c code:404 type:@"text/plain" body:[@"not found" dataUsingEncoding:NSUTF8StringEncoding] extra:nil];
    close(c);
}
- (void)serveHls:(int)c query:(NSString *)query {
    NSURL *src = [NSURL URLWithString:TVQuery(query, @"u")];
    if (!src) { [self reply:c code:404 type:@"text/plain" body:nil extra:nil]; return; }
    __block NSString *text = nil;
    __block NSURL *finalURL = src;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    NSURLSessionDataTask *t = [[TVTrust shared].session dataTaskWithURL:src completionHandler:^(NSData *d, NSURLResponse *r, NSError *e) {
        if (d && !e) text = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
        if (r.URL) finalURL = r.URL;
        dispatch_semaphore_signal(sem);
    }];
    [t resume];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(20 * NSEC_PER_SEC)));
    if (!text || [text rangeOfString:@"#EXTM3U"].location == NSNotFound) {
        [self reply:c code:404 type:@"text/plain" body:[@"upstream error" dataUsingEncoding:NSUTF8StringEncoding] extra:nil];
        return;
    }
    NSString *outText = TVRewriteMaster(text, finalURL, [TVQuery(query, @"h") integerValue],
                                        [TVQuery(query, @"a") lowercaseString], [TVQuery(query, @"s") lowercaseString]);
    [self reply:c code:200 type:@"application/vnd.apple.mpegurl" body:[outText dataUsingEncoding:NSUTF8StringEncoding] extra:@"Cache-Control: no-cache\r\n"];
}
- (void)serveFile:(int)c name:(NSString *)name request:(NSString *)req {
    NSString *file = [[TVLocalServer downloadsDir] stringByAppendingPathComponent:[name lastPathComponent] ?: @""];
    NSFileHandle *fh = [NSFileHandle fileHandleForReadingAtPath:file];
    if (!name.length || !fh) { [self reply:c code:404 type:@"text/plain" body:nil extra:nil]; return; }
    unsigned long long size = [[[NSFileManager defaultManager] attributesOfItemAtPath:file error:nil] fileSize];
    unsigned long long start = 0, end = size ? size - 1 : 0;
    BOOL partial = NO;
    NSRange rr = [req rangeOfString:@"Range: bytes=" options:NSCaseInsensitiveSearch];
    if (rr.location != NSNotFound) {
        NSString *spec = [[[req substringFromIndex:rr.location + rr.length] componentsSeparatedByString:@"\r\n"] firstObject];
        NSArray *se = [spec componentsSeparatedByString:@"-"];
        if (se.count == 2) {
            if ([se[0] length]) { start = strtoull([se[0] UTF8String], NULL, 10); if ([se[1] length]) end = strtoull([se[1] UTF8String], NULL, 10); }
            else if ([se[1] length]) { unsigned long long tail = strtoull([se[1] UTF8String], NULL, 10); start = size > tail ? size - tail : 0; }
            partial = YES;
        }
    }
    if (end >= size) end = size ? size - 1 : 0;
    if (size == 0 || start > end) { [self reply:c code:416 type:@"text/plain" body:nil extra:nil]; [fh closeFile]; return; }
    unsigned long long len = end - start + 1;
    NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %@\r\nContent-Type: video/mp4\r\nContent-Length: %llu\r\nAccept-Ranges: bytes\r\n"
                      "%@Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
                      partial ? @"206 Partial Content" : @"200 OK", len,
                      partial ? [NSString stringWithFormat:@"Content-Range: bytes %llu-%llu/%llu\r\n", start, end, size] : @""];
    NSData *h = [head dataUsingEncoding:NSUTF8StringEncoding];
    if (!TVSendAll(c, h.bytes, h.length)) { [fh closeFile]; return; }
    [fh seekToFileOffset:start];
    while (len > 0) {
        @autoreleasepool {
            NSUInteger chunk = (NSUInteger)(len > 262144 ? 262144 : len);
            NSData *d = [fh readDataOfLength:chunk];
            if (!d.length || !TVSendAll(c, d.bytes, d.length)) break;
            len -= d.length;
        }
    }
    [fh closeFile];
}
@end

#pragma mark - Загрузки фильмов на устройство (с 0.2.4)

// Скачиваются только mp4 (фильмы Архива кино, свои ссылки, файлы с ПК). Прогресс и готовность
// передаются в интерфейс: TV.nativeEvent('dl', {id, got, size} | {id, file, done:true} | {id, err}).
@interface TVDownloads : NSObject <NSURLSessionDownloadDelegate>
+ (instancetype)shared;
@property (nonatomic, weak) WKWebView *web;
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, strong) NSMutableDictionary *ids;     // taskIdentifier -> id загрузки
@property (nonatomic, strong) NSMutableDictionary *lastSent; // taskIdentifier -> время последнего события
- (void)start:(NSString *)dlId url:(NSURL *)url;
- (void)remove:(NSString *)file;
@end

@implementation TVDownloads
+ (instancetype)shared {
    static TVDownloads *s; static dispatch_once_t once;
    dispatch_once(&once, ^{
        s = [TVDownloads new];
        s.ids = [NSMutableDictionary dictionary];
        s.lastSent = [NSMutableDictionary dictionary];
        NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
        cfg.timeoutIntervalForRequest = 60;
        s.session = [NSURLSession sessionWithConfiguration:cfg delegate:s delegateQueue:[NSOperationQueue mainQueue]];
    });
    return s;
}
- (void)event:(NSDictionary *)d {
    NSData *j = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
    if (!j) return;
    NSString *js = [NSString stringWithFormat:@"TV.nativeEvent&&TV.nativeEvent('dl',%@)", [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding]];
    [self.web evaluateJavaScript:js completionHandler:nil];
}
- (void)start:(NSString *)dlId url:(NSURL *)url {
    if (!dlId || !url) return;
    NSURLSessionDownloadTask *t = [self.session downloadTaskWithURL:url];
    self.ids[[NSNumber numberWithUnsignedInteger:t.taskIdentifier]] = dlId;
    [t resume];
}
- (void)remove:(NSString *)file {
    if (!file.length) return;
    [[NSFileManager defaultManager] removeItemAtPath:[[TVLocalServer downloadsDir] stringByAppendingPathComponent:[file lastPathComponent]] error:nil];
}
- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)ch
 completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))done {
    [[TVTrust shared] URLSession:session didReceiveChallenge:ch completionHandler:done];   // те же корни Let's Encrypt
}
- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)t didWriteData:(int64_t)w
 totalBytesWritten:(int64_t)got totalBytesExpectedToWrite:(int64_t)size {
    NSNumber *k = [NSNumber numberWithUnsignedInteger:t.taskIdentifier];
    NSDate *last = self.lastSent[k];
    if (last && [last timeIntervalSinceNow] > -1.0) return;      // не чаще раза в секунду
    self.lastSent[k] = [NSDate date];
    NSString *dlId = self.ids[k];
    if (!dlId) return;
    NSMutableDictionary *d = [NSMutableDictionary dictionary];
    d[@"id"] = dlId; d[@"got"] = [NSNumber numberWithLongLong:got];
    if (size > 0) d[@"size"] = [NSNumber numberWithLongLong:size];
    [self event:d];
}
- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)t didFinishDownloadingToURL:(NSURL *)loc {
    NSNumber *k = [NSNumber numberWithUnsignedInteger:t.taskIdentifier];
    NSString *dlId = self.ids[k];
    if (!dlId) return;
    // без приведения double -> 64-битное целое: на armv7 оно требует ___fixunsdfdi, которого нет в SDK
    NSString *name = [NSString stringWithFormat:@"dl-%.0f.mp4", [[NSDate date] timeIntervalSince1970] * 1000.0];
    NSString *dest = [[TVLocalServer downloadsDir] stringByAppendingPathComponent:name];
    NSError *err = nil;
    [[NSFileManager defaultManager] moveItemAtURL:loc toURL:[NSURL fileURLWithPath:dest] error:&err];
    NSMutableDictionary *d = [NSMutableDictionary dictionary];
    d[@"id"] = dlId;
    if (err) d[@"err"] = @"не удалось сохранить файл";
    else {
        d[@"file"] = name; d[@"done"] = [NSNumber numberWithBool:YES];
        unsigned long long size = [[[NSFileManager defaultManager] attributesOfItemAtPath:dest error:nil] fileSize];
        d[@"size"] = [NSNumber numberWithUnsignedLongLong:size];
        d[@"got"] = d[@"size"];
    }
    [self.ids removeObjectForKey:k];
    [self event:d];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)t didCompleteWithError:(NSError *)error {
    NSNumber *k = [NSNumber numberWithUnsignedInteger:t.taskIdentifier];
    NSString *dlId = self.ids[k];
    if (!dlId || !error) return;
    [self.ids removeObjectForKey:k];
    NSMutableDictionary *d = [NSMutableDictionary dictionary];
    d[@"id"] = dlId;
    d[@"err"] = error.code == NSURLErrorNotConnectedToInternet ? @"нет интернета" : @"обрыв загрузки";
    [self event:d];
}
@end

#pragma mark - Экран с веб-интерфейсом

@interface TVWebVC : UIViewController <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate>
@property (nonatomic, strong) WKWebView *web;
@end

// WKUserContentController держит обработчик сильной ссылкой — прокладка от утечки
@interface TVWeakHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) id<WKScriptMessageHandler> target;
@end
@implementation TVWeakHandler
- (void)userContentController:(WKUserContentController *)u didReceiveScriptMessage:(WKScriptMessage *)m {
    [self.target userContentController:u didReceiveScriptMessage:m];
}
@end

@implementation TVWebVC

- (BOOL)prefersStatusBarHidden { return YES; }
- (UIInterfaceOrientationMask)supportedInterfaceOrientations { return UIInterfaceOrientationMaskAll; }

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = [UIColor colorWithRed:0.043 green:0.055 blue:0.078 alpha:1];

    WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
    cfg.allowsInlineMediaPlayback = YES;
    cfg.requiresUserActionForMediaPlayback = NO;       // iOS 9 API (в iOS 10 заменён, но работает)
    cfg.allowsAirPlayForMediaPlayback = YES;
    cfg.allowsPictureInPictureMediaPlayback = YES;

    [[TVLocalServer shared] start];   // локальный сервер: качество YouTube и скачанные фильмы
    UIDevice *dev = [UIDevice currentDevice];
    NSString *info = [NSString stringWithFormat:
        @"window.TV_NATIVE={platform:'ios',app:'%@',os:'%@',model:'%@',port:%d};%@", kAppVersion, dev.systemVersion, dev.model,
        [TVLocalServer shared].port,
        [TVStoreFiles savedScript]];
    WKUserScript *us = [[WKUserScript alloc] initWithSource:info injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
    [cfg.userContentController addUserScript:us];
    TVWeakHandler *h = [TVWeakHandler new];
    h.target = self;
    [cfg.userContentController addScriptMessageHandler:h name:@"tv"];

    self.web = [[WKWebView alloc] initWithFrame:self.view.bounds configuration:cfg];
    self.web.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    self.web.opaque = NO;
    self.web.backgroundColor = self.view.backgroundColor;
    self.web.scrollView.backgroundColor = self.view.backgroundColor;
    self.web.scrollView.bounces = NO;
    self.web.navigationDelegate = self;
    self.web.UIDelegate = self;
    [self.view addSubview:self.web];

    NSString *root = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"www"];
    NSURL *index = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"web/index.html"]];
    [self.web loadFileURL:index allowingReadAccessToURL:[NSURL fileURLWithPath:root isDirectory:YES]];
}

// Если процесс WebKit выгрузился из-за нехватки памяти (512 МБ на iPad mini 1) — перезагрузить
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView { [webView reload]; }

// window.open / target=_blank — во внешнем браузере
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)c
   forNavigationAction:(WKNavigationAction *)a windowFeatures:(WKWindowFeatures *)f {
    if (TVIsWebURL(a.request.URL)) [[UIApplication sharedApplication] openURL:a.request.URL];
    return nil;
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)a
decisionHandler:(void (^)(WKNavigationActionPolicy))decide {
    NSURL *u = a.request.URL;
    NSString *last = u.lastPathComponent ?: @"";
    // Ссылки на сертификаты — установить профиль через Safari (сам WebView его не установит)
    if ([last hasSuffix:@".mobileconfig"] || [last hasSuffix:@".der"]) { [self installCerts]; decide(WKNavigationActionPolicyCancel); return; }
    if ([u.scheme isEqualToString:@"file"] || [u.scheme isEqualToString:@"about"]) { decide(WKNavigationActionPolicyAllow); return; }
    // Любые внешние переходы — в Safari
    if (a.navigationType == WKNavigationTypeLinkActivated) {
        if (TVIsWebURL(u)) [[UIApplication sharedApplication] openURL:u];
        decide(WKNavigationActionPolicyCancel); return;
    }
    // Главная страница приложения не уходит на чужие сайты (встроенные фреймы — можно: плеер YouTube)
    if (a.targetFrame.isMainFrame) { decide(WKNavigationActionPolicyCancel); return; }
    decide(WKNavigationActionPolicyAllow);
}
// alert/confirm из JS
- (void)webView:(WKWebView *)w runJavaScriptAlertPanelWithMessage:(NSString *)msg initiatedByFrame:(WKFrameInfo *)f completionHandler:(void (^)(void))done {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:nil message:msg preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *x) { done(); }]];
    [self presentViewController:a animated:YES completion:nil];
}
- (void)webView:(WKWebView *)w runJavaScriptConfirmPanelWithMessage:(NSString *)msg initiatedByFrame:(WKFrameInfo *)f completionHandler:(void (^)(BOOL))done {
    UIAlertController *a = [UIAlertController alertControllerWithTitle:nil message:msg preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"Отмена" style:UIAlertActionStyleCancel handler:^(UIAlertAction *x) { done(NO); }]];
    [a addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *x) { done(YES); }]];
    [self presentViewController:a animated:YES completion:nil];
}

#pragma mark мост JS → натив

// Безопасность моста (0.3.0): наружу — только адреса http/https; команды — только от главного фрейма
static BOOL TVIsWebURL(NSURL *u) {
    NSString *sc = u.scheme.lowercaseString;
    return u && ([sc isEqualToString:@"http"] || [sc isEqualToString:@"https"]);
}
static NSURL *TVWebURLFrom(id v) {
    if (![v isKindOfClass:[NSString class]] || [(NSString *)v length] > 8192) return nil;
    NSURL *u = [NSURL URLWithString:v];
    return TVIsWebURL(u) ? u : nil;
}

- (void)userContentController:(WKUserContentController *)u didReceiveScriptMessage:(WKScriptMessage *)m {
    if (![m.body isKindOfClass:[NSDictionary class]]) return;
    if (m.frameInfo && !m.frameInfo.isMainFrame) return;        // встроенные фреймы (плеер YouTube) мостом не пользуются
    NSDictionary *b = m.body;
    NSString *cmd = [b[@"cmd"] isKindOfClass:[NSString class]] ? b[@"cmd"] : @"";
    if ([cmd isEqualToString:@"fetch"]) [self fetch:b];
    else if ([cmd isEqualToString:@"awake"]) [UIApplication sharedApplication].idleTimerDisabled = [b[@"on"] boolValue];
    else if ([cmd isEqualToString:@"open"]) {
        NSURL *url = TVWebURLFrom(b[@"url"]);
        if (url) [[UIApplication sharedApplication] openURL:url];
    }
    else if ([cmd isEqualToString:@"certs"]) [self installCerts];
    else if ([cmd isEqualToString:@"save"]) [TVStoreFiles save:b[@"key"] value:b[@"value"]];
    else if ([cmd isEqualToString:@"download"]) {
        [TVDownloads shared].web = self.web;
        [[TVDownloads shared] start:b[@"id"] url:TVWebURLFrom(b[@"url"])];
    }
    else if ([cmd isEqualToString:@"dlDelete"]) {
        if ([b[@"file"] isKindOfClass:[NSString class]]) [[TVDownloads shared] remove:b[@"file"]];
    }
}

- (void)installCerts {
    NSString *p = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"www/web/certs/BridgeTV-roots.mobileconfig"];
    [TVProfileServer serveFile:p open:YES];
}

// fetch: {id, url, timeout, method, body, headers} → TV.nativeCb(id, ошибка|null, текст, статус)
- (void)fetch:(NSDictionary *)b {
    NSString *cbId = [NSString stringWithFormat:@"%@", b[@"id"]];
    NSURL *url = TVWebURLFrom(b[@"url"]);
    if (!url) { [self reply:cbId error:@"адрес" text:nil status:0]; return; }
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    NSNumber *t = b[@"timeout"];
    req.timeoutInterval = t ? [t doubleValue] / 1000.0 : 20;
    if ([b[@"method"] isEqual:@"POST"]) req.HTTPMethod = @"POST";
    if ([b[@"body"] isKindOfClass:[NSString class]]) req.HTTPBody = [b[@"body"] dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *hd = b[@"headers"];
    if ([hd isKindOfClass:[NSDictionary class]]) for (NSString *k in hd) [req setValue:[NSString stringWithFormat:@"%@", hd[k]] forHTTPHeaderField:k];
    __weak __typeof__(self) ws = self;
    NSURLSessionDataTask *task = [[TVTrust shared].session dataTaskWithRequest:req
        completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
        NSInteger code = [resp isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)resp).statusCode : 0;
        NSString *text = nil, *e = nil;
        if (err) {
            if (err.code == NSURLErrorTimedOut) e = @"таймаут";
            else if (err.code == NSURLErrorServerCertificateUntrusted || err.code == NSURLErrorSecureConnectionFailed ||
                     err.code == NSURLErrorCancelled) e = @"сертификат";
            else if (err.code == NSURLErrorNotConnectedToInternet) e = @"нет интернета";
            else e = @"нет связи";
        } else {
            text = [[NSString alloc] initWithData:data ?: [NSData data] encoding:NSUTF8StringEncoding];
            if (!text) text = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
            if (code < 200 || code >= 300) e = [NSString stringWithFormat:@"HTTP %ld", (long)code];
        }
        dispatch_async(dispatch_get_main_queue(), ^{ [ws reply:cbId error:e text:text status:code]; });
    }];
    [task resume];
}

- (void)reply:(NSString *)cbId error:(NSString *)e text:(NSString *)text status:(NSInteger)code {
    // Безопасная передача строк в JS — через JSON-массив
    NSArray *args = [NSArray arrayWithObjects:cbId, (e ?: (id)[NSNull null]), (text ?: @""), [NSNumber numberWithInteger:code], nil];
    NSData *j = [NSJSONSerialization dataWithJSONObject:args options:0 error:nil];
    NSString *js = [NSString stringWithFormat:@"TV.nativeCb.apply(null,%@)", [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding]];
    [self.web evaluateJavaScript:js completionHandler:nil];
}
@end

#pragma mark - Приложение

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation AppDelegate
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)opts {
    NSError *err = nil;
    [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayback error:&err];
    [[AVAudioSession sharedInstance] setActive:YES error:&err];
    [NSURLCache setSharedURLCache:[[NSURLCache alloc] initWithMemoryCapacity:4 * 1024 * 1024
                                                                diskCapacity:64 * 1024 * 1024 diskPath:@"tv-cache"]];
    self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    self.window.backgroundColor = [UIColor blackColor];
    self.window.rootViewController = [TVWebVC new];
    [self.window makeKeyAndVisible];
    return YES;
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
    }
}
