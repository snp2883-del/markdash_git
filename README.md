# BGS.MarkDash

Маркетинговый дашборд BGS Group. Проект Клуба Амбассадоров.

## Деплой на Vercel

### 1. GitHub
```bash
unzip markdash.zip && cd markdash
git init && git add .
git commit -m "BGS.MarkDash"
git remote add origin https://github.com/ВАШ_ЮЗЕР/markdash.git
git push -u origin main
```

### 2. Vercel
vercel.com → Add New → Project → выбери репозиторий → Framework: **Other** → Deploy

### 3. Environment Variables

**Обязательные:**
```
JWT_SECRET                        (длинная случайная строка)
CRED__BITRIX24__WEBHOOK           https://bitrix-dev.bgs-group.eu/rest/1414/banioa8pgg0p0xdz/
CRED__BITRIX24__ENTITY_TYPE       both
CRED__YANDEX_METRICA__TOKEN       (OAuth токен)
CRED__YANDEX_METRICA__COUNTER_ID  99208100
```

**Google Sheets (медиаплан):**
```
CRED__SHEETS__SPREADSHEET_ID      1sx_aX23T_HtgRCk6KxVbSoU97ccvO3nTlAYYCfMc0V4
CRED__SHEETS__SHEET_GID           1298716681
CRED__SHEETS__SHEET_NAME          schedule EU+RU
CRED__SHEETS__SA_EMAIL            sheets-parser@sheets-parser-500513.iam.gserviceaccount.com
CRED__SHEETS__SA_KEY              (ключ PEM целиком, \n сохранит)
```

**Telegram:**
```
CRED__TELEGRAM__BOT_TOKEN
CRED__TELEGRAM__CHAT_ID
```

**Прочее:**
```
CRED__YANDEX_DIRECT__TOKEN
CRED__GOOGLE__CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN / GA4_PROPERTY_ID
CRED__LINKEDIN__ACCESS_TOKEN / ACCOUNT_ID
```

**Пользователи** (опционально, есть демо):
```
USER__ADMIN__HASH   (bcrypt хэш пароля)
USER__ADMIN__ROLE   admin
USER__ADMIN__NAME   Иван Иванов
```
Генерация хэша: `node -e "const b=require('bcryptjs');console.log(b.hashSync('пароль',10))"`

---

## Демо-доступ (без бэкенда)
- `admin` / `admin123`
- `marketing` / `market2024`
- `analyst` / `data456`

---

## Локальный запуск
```bash
npm install
cp .env.example .env
node server/index.js   # → http://localhost:3000
```

---

## Медиаплан — как работает автоматизация

Дашборд читает данные из 3 листов Google-таблицы:

| Лист | Что берёт |
|---|---|
| `schedule EU+RU` | План (проект, платформа, кампания, target, даты, статус) |
| `mediaplan EU` | Факт: Total costs → Бюджет факт, Lead forms → Лиды факт, CPO → CPL |
| `mediaplan RU` | То же для русских проектов |

**Матчинг между листами** — по проекту + платформе + target/campaign.

**Кнопки в медиаплане:**
- «Синхр. Sheets» — тянет план + факт из 3 листов, статус из `schedule EU+RU`
- «Факт из B24» — считает лиды по UTM-меткам из Bitrix24

Медиаплан также поддерживает CSV импорт/экспорт, ручное добавление строк, три вида (Таблица / Ганта / Сводная), алерты и Telegram-уведомления.

---

## Статус интеграций
| Платформа | Статус |
|---|---|
| Яндекс.Метрика | ✅ Работает |
| Bitrix24 CRM | ✅ Работает |
| Google Sheets | ✅ Работает (Service Account) |
| Яндекс.Директ | ⏳ Ждёт одобрения заявки |
| Google Analytics 4 | ⏳ Ждёт токенов |
| LinkedIn Ads | ⏳ Ждёт токенов |

---

## После деплоя — очистка кэша браузера

Первый вход после обновления — очисти localStorage:
```js
localStorage.clear();
location.reload();
```

Или только медиаплан:
```js
localStorage.removeItem('bgs_markdash_mediaplan_db');
localStorage.removeItem('mp_last_sync');
location.reload();
```

---

## Файловая структура
```
public/index.html      — SPA фронтенд (~6775 строк)
api/index.js           — Vercel Serverless handler (~1772 строки)
server/index.js        — Локальный Express сервер
vercel.json            — Routing (crons убраны для Hobby плана)
package.json           — Deps: express, jwt, bcryptjs, node-fetch
```
