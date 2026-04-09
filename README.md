# Energía Colectiva - Backend

## Estructura

```
backend/
├── server.js          # Servidor Express + Socket.io
├── config.js          # Configuración MongoDB
├── railway.json       # Configuración despliegue
└── package.json
```

## API Endpoints

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/users/:uid/profiles` | Obtener perfiles |
| POST | `/api/users/:uid/profiles` | Guardar perfiles |
| GET | `/api/users/:uid/salas` | Obtener salas |
| POST | `/api/users/:uid/salas` | Guardar salas |
| GET | `/api/stats` | Estadísticas |

## Socket.io

Eventos en tiempo real:
- `join-room` / `leave-room`
- `energy-emitted`
- `state-update`

## Comandos

```bash
npm install
npm start     # Producción
npm run dev   # Desarrollo
```

## URL Producción

https://tp-eventos-backend-production.up.railway.app
