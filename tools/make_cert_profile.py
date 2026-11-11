# -*- coding: utf-8 -*-
"""
Собирает web/certs/BridgeTV-roots.mobileconfig — профиль iOS с корневыми сертификатами
Let's Encrypt (ISRG Root X1, X2, YE, YR).

Зачем: iOS 9 и старше не знают эти корни, поэтому HTTPS-сайты на Let's Encrypt
(зеркала YouTube, обновление каталога с GitHub, многие ТВ-потоки) на них не
открываются — плеер «долго грузит» и падает. После установки профиля iOS
доверяет этим сайтам во всех приложениях (и в Safari, и в AVPlayer).

Исходные .der лежат в web/certs/ (скачаны с https://letsencrypt.org/certificates/).
Запуск: python tools/make_cert_profile.py
"""
import os
import plistlib
import ssl
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERTS = os.path.join(ROOT, "web", "certs")
FILES = [("isrgrootx1.der", "ISRG Root X1"), ("isrg-root-x2.der", "ISRG Root X2"),
         ("root-yr.der", "ISRG Root YR"), ("root-ye.der", "ISRG Root YE"),
         # CDN jsDelivr (обновление каталога) — корень 2021 года, в iOS 9 его нет
         ("sectigo-r46.der", "Sectigo Public Server Authentication Root R46")]
NS = uuid.UUID("6f1c3a52-6b8e-4f0a-9d7e-1a2b3c4d5e6f")  # стабильные UUID между сборками


def main():
    payloads = []
    for fn, name in FILES:
        der = open(os.path.join(CERTS, fn), "rb").read()
        ssl.DER_cert_to_PEM_cert(der)  # проверка, что файл — сертификат
        payloads.append({
            "PayloadType": "com.apple.security.root", "PayloadVersion": 1,
            "PayloadIdentifier": "tv.app.roots." + fn.split(".")[0],
            "PayloadUUID": str(uuid.uuid5(NS, fn)).upper(),
            "PayloadDisplayName": name, "PayloadContent": der,
            "PayloadCertificateFileName": fn,
        })
    profile = {
        "PayloadType": "Configuration", "PayloadVersion": 1,
        "PayloadIdentifier": "tv.app.roots", "PayloadUUID": str(uuid.uuid5(NS, "profile")).upper(),
        "PayloadDisplayName": "BridgeTV: сертификаты для старых iOS",
        "PayloadDescription": "Корневые сертификаты Let's Encrypt (ISRG) и Sectigo R46. Нужны iOS 9–10, чтобы открывались "
                              "HTTPS-сайты и трансляции. Ничего не отслеживает и не меняет других настроек.",
        "PayloadOrganization": "BridgeTV (open source)", "PayloadRemovalDisallowed": False,
        "PayloadContent": payloads,
    }
    out = os.path.join(CERTS, "BridgeTV-roots.mobileconfig")
    with open(out, "wb") as f:
        plistlib.dump(profile, f)
    print("OK ->", out)


if __name__ == "__main__":
    main()
