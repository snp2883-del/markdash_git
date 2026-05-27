# MarkDash — Marketing Dashboard

Полноценный маркетинговый дашборд с Node.js бэкендом и реальными API-интеграциями.

## Быстрый старт

```bash
# 1. Распакуйте архив и перейдите в папку
cd markdash

# 2. Установите зависимости
npm install

# 3. Создайте файл с переменными окружения
cp .env.example .env

# 4. Запустите сервер
npm start

# 5. Откройте в браузере
open http://localhost:3000
```

Логин: **admin** / Пароль: **admin123**

---

## Настройка API-подключений

После запуска перейдите в **Настройки API** в боковом меню.
Введите токены в нужных блоках → нажмите **Сохранить** → нажмите **Проверить**.

Токены сохраняются в файл `.credentials.json` на сервере — браузер их никогда не видит.

---

## Получение токенов

### Yandex.Metrica + Yandex.Direct

1. Зайдите на [oauth.yandex.ru](https://oauth.yandex.ru)
2. Создайте приложение или используйте отладочный токен
3. Нужные права: `metrika:read` (Метрика), `direct:api` (Директ)
4. Скопируйте токен в настройки дашборда

```
Метрика: нужен ID счётчика (найдёте в интерфейсе Метрики — число в URL)
Директ: логин клиента нужен только при работе через агентский аккаунт
```

### Google Analytics 4 + Google Ads

1. Зайдите в [console.cloud.google.com](https://console.cloud.google.com)
2. Создайте проект, включите **Google Analytics Data API** и **Google Ads API**
3. Создайте **OAuth 2.0 Client ID** (тип: Web application)
4. Добавьте `https://developers.google.com/oauthplayground` в Redirect URIs
5. Получите refresh_token через [OAuth Playground](https://developers.google.com/oauthplayground):
   - Шестерёнка → Use your own OAuth credentials → вставьте Client ID и Secret
   - Выберите скоупы: `https://www.googleapis.com/auth/analytics.readonly` и `https://www.googleapis.com/auth/adwords`
   - Authorize → Exchange → скопируйте `refresh_token`
6. GA4 Property ID — числовой ID из интерфейса GA4 (Настройки → Свойство)
7. Google Ads Developer Token — из аккаунта Google Ads API Center

### LinkedIn Ads

1. Зайдите на [linkedin.com/developers](https://www.linkedin.com/developers/apps)
2. Создайте приложение, запросите доступ к **Marketing Developer Platform**
3. Нужные права: `r_ads_reporting`, `r_organization_social`
4. Получите access_token через OAuth 2.0 (токен живёт 60 дней, нужно обновлять)
5. Account ID — числовой ID рекламного аккаунта

---

## Структура проекта

```
markdash/
├── server/
│   └── index.js          # Express сервер, прокси к API
├── public/
│   └── index.html        # Фронтенд дашборда
├── .env.example          # Шаблон переменных окружения
├── .env                  # Ваши реальные переменные (НЕ коммитить в git!)
├── .credentials.json     # Сохранённые токены (создаётся автоматически, НЕ коммитить!)
├── package.json
└── README.md
```

## API Endpoints

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/health` | Статус сервера и настроенных платформ |
| GET | `/api/credentials` | Маскированные значения токенов |
| POST | `/api/credentials` | Сохранить токены |
| GET | `/api/test/:platform` | Проверить подключение |
| GET | `/api/data/all` | Данные из всех настроенных источников |
| GET | `/api/data/yandex-metrica` | Данные Yandex.Metrica |
| GET | `/api/data/yandex-direct` | Данные Yandex.Direct |
| GET | `/api/data/google-analytics` | Данные Google Analytics 4 |
| GET | `/api/data/google-ads` | Данные Google Ads |
| GET | `/api/data/linkedin` | Данные LinkedIn Ads |

Все data-эндпоинты принимают параметры `?from=YYYY-MM-DD&to=YYYY-MM-DD` или `?days=30`.

## Безопасность

- Токены хранятся в `.credentials.json` с правами `600` (только владелец)
- Токены из `.env` имеют приоритет над сохранёнными через UI
- Браузер получает только маскированные значения (первые 4 символа + `••••••••` + последние 3)
- Rate limiting: 60 запросов/минуту на `/api/*`
- Добавьте `.credentials.json` и `.env` в `.gitignore`
