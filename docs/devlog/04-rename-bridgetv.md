# Шаг 04 — Название BridgeTV (0.2.1)

**Запрос.** Выбрать название: «совместимое со всем» и понятно, что это ТВ. Выбрано **BridgeTV** — мост между старой техникой и современным ТВ.

## Сделано
- Видимое имя: `CFBundleDisplayName`, `<title>`, `manifest.json`, `TV.APP_NAME`, профиль сертификатов `BridgeTV-roots.mobileconfig`, файл `BridgeTV.ipa`, репозиторий `kyranashi/bridgetv`, Pages `kyranashi.github.io/bridgetv/web/`.
- **Не менялись** Bundle ID `com.kyranashi.tv` (новая версия ставится поверх, данные сохраняются) и внутреннее имя объекта `TV` в JavaScript.
- `tools/check_ipa.py` находит бинарник по шаблону `Payload/<Имя>.app/<Имя>` — не зависит от названия.
