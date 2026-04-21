// ============================================================
// IMPORTANTE - NOTA SOBRE DESPLIEGUE
// ============================================================
// El backend se deploya en Railway. El día 08/04/2026 Railway tuvo
// problemas con su CDN que impide el funcionamiento correcto de CORS.
// Las APIs devuelven 404 cacheados sin headers de CORS.
// Más info: https://railway.com/project/...
// Estado: En espera de resolución por parte de Railway.
// ============================================================

// IMPORTACIÓN DE LIBRERÍAS

require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");
const config = require("./config");

// CREACIÓN DEL SERVIDOR

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Ruta base
app.get("/", (req, res) => {
  res.send("Energía Colectiva API OK - AI ready: " + (process.env.OPENAI_API_KEY ? "YES" : "NO"));
});



const server = http.createServer(app);

// CONFIGURACIÓN DE SOCKET.IO

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

// MONGO DB

let db;
const initMongo = async () => {
  try {
    const client = new MongoClient(config.mongodbUri);
    await client.connect();
    db = client.db("tp-eventos");
  } catch (err) {
    console.error("Error conectando a MongoDB:", err.message);
  }
};

// ESTADO DE LAS SALAS

const rooms = {};

async function saveStat(roomName, type, data = {}) {
  if (!db) return;
  try {
    await db.collection("stats").insertOne({
      room: roomName.toLowerCase(),
      type,
      timestamp: new Date(),
      ...data
    });
  } catch (err) {
    console.error("Error guardando stat:", err.message);
  }
}

const GESTURES = ["pump", "wave", "shake", "rotate"];
const THRESHOLD_PERCENT = 0.8;
const THRESHOLDS = [0, 50, 500, 1000];
const GESTURE_DURATION = 3000;
const REPETITIONS_NEEDED = 5;
const ACTIVITY_THRESHOLD = 3;

const ROOM_TIMEOUT = 30 * 60 * 1000;

function getRoomState(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      points: 0,
      color: "orange",
      activeUsers: new Set(),
      gestureActive: false,
      currentGesture: null,
      gestureStartTime: null,
      usersDoingGesture: new Set(),
      gestureRepetitions: new Map(),
      lastThresholdIndex: 0,
      gestureTimer: null,
      freeMovementPhase: true,
      usersMoving: new Set(),
      moveRepetitions: new Map(),
      nearThreshold: false,
      lastActivity: Date.now()
    };
  }
  
  if (rooms[roomName].activeUsers.size === 0 && Date.now() - rooms[roomName].lastActivity > ROOM_TIMEOUT) {
    rooms[roomName].points = 0;
    rooms[roomName].color = "orange";
    rooms[roomName].lastThresholdIndex = 0;
    rooms[roomName].nearThreshold = false;
    rooms[roomName].freeMovementPhase = true;
    rooms[roomName].usersDoingGesture.clear();
    rooms[roomName].gestureRepetitions.clear();
    rooms[roomName].usersMoving.clear();
    rooms[roomName].moveRepetitions.clear();
    console.log(`Sala ${roomName} - Reset por inactividad`);
  }
  
  return rooms[roomName];
}

function updateRoomState(roomName) {
  const room = rooms[roomName];
  
  if (room.points >= 1000) {
    room.color = "green";
  } else if (room.points >= 500) {
    room.color = "yellow";
  } else {
    room.color = "orange";
  }
  
  return room;
}

function getNextThreshold(currentPoints) {
  for (let i = THRESHOLDS.length - 1; i >= 0; i--) {
    if (currentPoints < THRESHOLDS[i]) {
      return THRESHOLDS[i];
    }
  }
  return THRESHOLDS[THRESHOLDS.length - 1];
}

function checkAndTriggerGesture(roomName) {
  const room = rooms[roomName];
  
  if (room.gestureActive) return;
  if (room.points >= 1000) return;
  
  const currentThreshold = room.lastThresholdIndex > 0 ? THRESHOLDS[room.lastThresholdIndex] : 0;
  const nextThreshold = getNextThreshold(room.points);
  
  if (nextThreshold > currentThreshold && room.points >= nextThreshold - 50 && room.points < nextThreshold) {
    startGesture(roomName);
  }
}

function checkGestureCompletion(roomName) {
  const room = rooms[roomName];
  
  if (room.gestureActive) return;
  if (room.points >= 1000) return;
  
  const currentThresholdIndex = THRESHOLDS.indexOf(getNextThreshold(room.points));
  const nextThreshold = THRESHOLDS[currentThresholdIndex + 1];
  
  if (!nextThreshold) return;
  
  if (room.points >= nextThreshold - 30 && room.points < nextThreshold && !room.nearThreshold) {
    room.nearThreshold = true;
    room.freeMovementPhase = false;
    
    io.to(roomName).emit("nearThreshold", {
      threshold: nextThreshold,
      current: room.points
    });
  } else if (room.points < nextThreshold - 50 && room.nearThreshold) {
    room.nearThreshold = false;
    room.freeMovementPhase = true;
  }
}

function checkGestureSuccess(roomName) {
  const room = rooms[roomName];
  
  if (room.usersDoingGesture.size === 0) {
    room.gestureActive = false;
    room.currentGesture = null;
    room.usersDoingGesture.clear();
    room.gestureRepetitions.clear();
    if (room.gestureTimer) {
      clearTimeout(room.gestureTimer);
      room.gestureTimer = null;
    }
    io.to(roomName).emit("stateUpdate", {
      points: room.points,
      color: room.color,
      room: roomName,
      gestureActive: false,
      gesturePhase: "free"
    });
    return;
  }
  
  const participation = room.usersDoingGesture.size / room.activeUsers.size;
  const currentThresholdIndex = THRESHOLDS.indexOf(getNextThreshold(room.points)) - 1;
  const nextThreshold = THRESHOLDS[currentThresholdIndex + 1] || 1000;
  
  if (participation >= THRESHOLD_PERCENT) {
    const pointsToAdd = Math.max(0, nextThreshold - room.points);
    room.points = Math.min(1000, room.points + pointsToAdd);
    room.lastThresholdIndex = currentThresholdIndex + 1;
    room.freeMovementPhase = true;
    room.nearThreshold = false;
    
    io.to(roomName).emit("gestureSuccess", {
      gesture: room.currentGesture,
      participation: Math.round(participation * 100),
      pointsAdded: pointsToAdd
    });
    
    console.log(`Sala ${roomName} - Gesto exitoso! ${Math.round(participation * 100)}% participó, +${pointsToAdd} puntos`);
    
    updateRoomState(roomName);
    io.to(roomName).emit("stateUpdate", {
      points: room.points,
      color: room.color,
      room: roomName,
      gestureActive: false,
      gesturePhase: "free"
    });
  } else {
    io.to(roomName).emit("gestureFailed", {
      gesture: room.currentGesture,
      participation: Math.round(participation * 100),
      needed: Math.round(THRESHOLD_PERCENT * 100)
    });
    
    console.log(`Sala ${roomName} - Gesto falló: ${Math.round(participation * 100)}% (necesitaba 80%)`);
    
    room.freeMovementPhase = true;
    room.nearThreshold = false;
    
    io.to(roomName).emit("stateUpdate", {
      points: room.points,
      color: room.color,
      room: roomName,
      gestureActive: false,
      gesturePhase: "free"
    });
  }
  
  room.gestureActive = false;
  room.currentGesture = null;
  room.usersDoingGesture.clear();
  room.gestureRepetitions.clear();
  room.gestureStartTime = null;
  
  if (room.gestureTimer) {
    clearTimeout(room.gestureTimer);
    room.gestureTimer = null;
  }
}

function startGesture(roomName) {
  const room = getRoomState(roomName);
  
  room.gestureActive = true;
  room.currentGesture = GESTURES[Math.floor(Math.random() * GESTURES.length)];
  room.gestureStartTime = Date.now();
  room.usersDoingGesture.clear();
  
  io.to(roomName).emit("gestureStart", {
    gesture: room.currentGesture,
    duration: GESTURE_DURATION
  });
  
  console.log(`Sala ${roomName} - Gesto iniciado: ${room.currentGesture}`);
  
  room.gestureTimer = setTimeout(() => {
    checkGestureSuccess(roomName);
  }, GESTURE_DURATION);
}

function emitGestureStatus(roomName) {
  const room = rooms[roomName];
  if (!room.gestureActive) return;
  
  const participation = room.activeUsers.size > 0 
    ? Math.round((room.usersDoingGesture.size / room.activeUsers.size) * 100) 
    : 0;
  
  io.to(roomName).emit("gestureStatus", {
    doingGesture: room.usersDoingGesture.size,
    totalUsers: room.activeUsers.size,
    participation: participation
  });
}

function checkMovementProgress(roomName) {
  const room = rooms[roomName];
  
  const currentThresholdIndex = THRESHOLDS.indexOf(getNextThreshold(room.points));
  const nextThreshold = THRESHOLDS[currentThresholdIndex + 1];
  
  if (!nextThreshold || room.points >= nextThreshold - 30) return;
  
  const eligibleUsers = [];
  room.moveRepetitions.forEach((count, userId) => {
    if (count >= REPETITIONS_NEEDED) {
      eligibleUsers.push(userId);
    }
  });
  
  if (eligibleUsers.length >= Math.ceil(room.activeUsers.size * THRESHOLD_PERCENT) && room.activeUsers.size >= 2) {
    const pointsNeeded = nextThreshold - room.points;
    const pointsPerUser = Math.floor(pointsNeeded / eligibleUsers.length);
    
    eligibleUsers.forEach(userId => {
      room.points = Math.min(1000, room.points + pointsPerUser);
    });
    
    room.moveRepetitions.clear();
    room.usersMoving.clear();
    
    io.to(roomName).emit("movementBonus", {
      usersParticipating: eligibleUsers.length,
      totalUsers: room.activeUsers.size,
      pointsAdded: pointsNeeded
    });
    
    updateRoomState(roomName);
    io.to(roomName).emit("stateUpdate", {
      points: room.points,
      color: room.color,
      room: roomName,
      gestureActive: false,
      gesturePhase: "free"
    });
    
    checkGestureCompletion(roomName);
  }
}

// CONEXIÓN DE USUARIOS

io.on("connection", (socket) => {
  const roomName = socket.handshake.query.room || "default";
  
  socket.join(roomName);
  console.log(`Usuario ${socket.id} conectado a sala: ${roomName}`);
  
  saveStat(roomName, "connect", { socketId: socket.id });

  const room = getRoomState(roomName);
  room.activeUsers.add(socket.id);
  
  socket.emit("stateUpdate", {
    points: room.points,
    color: room.color,
    room: roomName,
    gestureActive: room.gestureActive,
    currentGesture: room.currentGesture,
    gestureDuration: room.gestureActive ? GESTURE_DURATION : 0,
    gesturePhase: room.freeMovementPhase ? "free" : "sync",
    nearThreshold: room.nearThreshold
  });
  
  emitGestureStatus(roomName);

  socket.on("energy", (data) => {
    const room = getRoomState(roomName);
    const energy = data.energy || 0;
    
    room.lastActivity = Date.now();

    if (room.points >= 1000) return;
    if (energy > 20) return;

    const oldPoints = room.points;
    room.points += energy;
    if (room.points > 1000) {
      room.points = 1000;
    }

    const updatedRoom = updateRoomState(roomName);

    console.log(`Sala ${roomName} - Puntos: ${updatedRoom.points} (+${energy})`);
    
    saveStat(roomName, "energy", { energy, totalPoints: updatedRoom.points });

    io.to(roomName).emit("stateUpdate", {
      points: updatedRoom.points,
      color: updatedRoom.color,
      room: roomName,
      gestureActive: room.gestureActive,
      currentGesture: room.currentGesture,
      gesturePhase: room.freeMovementPhase ? "free" : "sync",
      nearThreshold: room.nearThreshold
    });
    
    if (oldPoints < room.points) {
      checkGestureCompletion(roomName);
    }
  });
  
  socket.on("doGesture", (data) => {
    const room = getRoomState(roomName);
    room.lastActivity = Date.now();
    
    if (room.gestureActive && data.gesture === room.currentGesture) {
      room.usersDoingGesture.add(socket.id);
      emitGestureStatus(roomName);
    } else if (room.freeMovementPhase && room.nearThreshold) {
      const currentCount = room.moveRepetitions.get(socket.id) || 0;
      room.moveRepetitions.set(socket.id, currentCount + 1);
      room.usersMoving.add(socket.id);
      
      if (currentCount + 1 >= REPETITIONS_NEEDED) {
        checkMovementProgress(roomName);
      }
    }
  });
  
  socket.on("startGestureEvent", () => {
    const room = getRoomState(roomName);
    if (!room.gestureActive && room.points < 1000) {
      startGesture(roomName);
    }
  });

  socket.on("reset", () => {
    const room = getRoomState(roomName);
    room.points = 0;
    room.color = "orange";
    room.lastThresholdIndex = 0;
    
    if (room.gestureTimer) {
      clearTimeout(room.gestureTimer);
      room.gestureTimer = null;
    }
    room.gestureActive = false;
    room.currentGesture = null;
    room.usersDoingGesture.clear();
    room.gestureRepetitions.clear();
    room.freeMovementPhase = true;
    room.nearThreshold = false;
    room.usersMoving.clear();
    room.moveRepetitions.clear();

    io.to(roomName).emit("stateUpdate", {
      points: 0,
      color: "orange",
      room: roomName,
      gestureActive: false
    });

    console.log(`Sala ${roomName} - Reset ejecutado`);
  });

  socket.on("disconnect", () => {
    const room = rooms[roomName];
    if (room) {
      room.activeUsers.delete(socket.id);
      room.usersDoingGesture.delete(socket.id);
      emitGestureStatus(roomName);
    }
    console.log(`Usuario ${socket.id} desconectado de sala: ${roomName}`);
    saveStat(roomName, "disconnect", { socketId: socket.id });
  });
});

// API: listar salas

app.get("/api/rooms", (req, res) => {
  const roomList = Object.keys(io.sockets.adapter.rooms);
  res.json({ rooms: roomList });
});

// API: info de sala

app.get("/api/rooms/:name", (req, res) => {
  const room = rooms[req.params.name];
  if (!room) {
    return res.json({ error: "Sala no encontrada" });
  }
  res.json({
    points: room.points,
    color: room.color,
    activeUsers: room.activeUsers.size,
    gestureActive: room.gestureActive,
    currentGesture: room.currentGesture
  });
});

// =====================
// API: PERFILES DE USUARIO (MongoDB)
// =====================

app.get("/api/users/:uid/profiles", async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await db.collection("users").findOne({ uid });
    res.set("Cache-Control", "no-store");
    res.json({ profiles: user?.profiles || [] });
  } catch (err) {
    console.error(err);
    res.set("Cache-Control", "no-store");
    res.status(500).json({ error: "Error al obtener perfiles" });
  }
});

app.post("/api/users/:uid/profiles", async (req, res) => {
  try {
    const { uid } = req.params;
    const { profiles } = req.body;
    
    await db.collection("users").updateOne(
      { uid },
      { $set: { profiles } },
      { upsert: true }
    );
    
    res.set("Cache-Control", "no-store");
    res.json({ success: true, profiles });
  } catch (err) {
    console.error(err);
    res.set("Cache-Control", "no-store");
    res.status(500).json({ error: "Error al guardar perfiles" });
  }
});

// =====================
// API: SALAS DE USUARIO (MongoDB)
// =====================

app.get("/api/users/:uid/salas", async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await db.collection("users").findOne({ uid });
    res.json({ salas: user?.salas || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener salas" });
  }
});

app.post("/api/users/:uid/salas", async (req, res) => {
  try {
    const { uid } = req.params;
    const { salas } = req.body;
    
    await db.collection("users").updateOne(
      { uid },
      { $set: { salas } },
      { upsert: true }
    );
    
    res.json({ success: true, salas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar salas" });
  }
});

// =====================
// API: ESTADÍSTICAS
// =====================

app.get("/api/stats/:sala", async (req, res) => {
  if (!db) {
    return res.json({ stats: [], summary: { connections: 0, disconnections: 0, activeConnections: 0, totalEnergy: 0 } });
  }
  
  try {
    const sala = req.params.sala.toLowerCase();
    const { limit = 100 } = req.query;
    
    const stats = await db.collection("stats")
      .find({ room: sala })
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .toArray();
    
    const connections = stats.filter(s => s.type === "connect").length;
    const disconnections = stats.filter(s => s.type === "disconnect").length;
    const totalEnergy = stats
      .filter(s => s.type === "energy")
      .reduce((sum, s) => sum + (s.energy || 0), 0);
    
    const room = io.sockets.adapter.rooms.get(sala);
    const activeConnections = room ? room.size : 0;
    
    res.json({
      stats,
      summary: {
        connections,
        disconnections,
        activeConnections,
        totalEnergy
      }
    });
  } catch (err) {
    console.error(err);
    res.json({ stats: [], summary: { connections: 0, disconnections: 0, activeConnections: 0, totalEnergy: 0 } });
  }
});

// INICIAR SERVIDOR

const PORT = process.env.PORT || 3000;

initMongo().then(() => {
  server.listen(PORT, () => {
    console.log(`Servidor corriendo en ${config.serverUrl}`);
  });
}).catch(err => {
  console.error("Error conectando a MongoDB:", err);
  server.listen(PORT, () => {
    console.log(`Servidor corriendo SIN MongoDB en ${config.serverUrl}`);
  });
});
