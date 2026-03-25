// IMPORTACIÓN DE LIBRERÍAS

// Express → framework para crear servidor web
const express = require("express");

// http → módulo nativo de Node para crear servidor
const http = require("http");

// Socket.IO → permite comunicación en tiempo real
const { Server } = require("socket.io");

// CREACIÓN DEL SERVIDOR

// Inicializamos express
const app = express();

// Creamos servidor HTTP usando express
const server = http.createServer(app);


// CONFIGURACIÓN DE SOCKET.IO

// Creamos instancia de Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*" // permite conexiones desde cualquier origen (útil para pruebas)
  }
});


// ESTADO GLOBAL DEL SISTEMA

// Acumulador de puntos colectivos
let globalPoints = 0;

// Estado visual actual (color global)
let currentColor = "orange";

// FUNCIÓN: ACTUALIZAR ESTADO

// Define el color según los puntos acumulados
function updateState() {

  if (globalPoints >= 1000) {
    currentColor = "green";

  } else if (globalPoints >= 500) {
    currentColor = "yellow";

  } else {
    currentColor = "orange";
  }
}

// CONEXIÓN DE USUARIOS

// Se ejecuta cada vez que un usuario se conecta
io.on("connection", (socket) => {

  console.log("Usuario conectado:", socket.id);

  // ENVIAR ESTADO INICIAL

  // Cuando alguien entra, recibe el estado actual
  socket.emit("stateUpdate", {
    points: globalPoints,
    color: currentColor
  });


  // RECIBIR ENERGÍA (INTERACCIÓN)

  socket.on("energy", (data) => {

    // Extraemos la energía enviada
    const energy = data.energy || 0;

    // 🚫 si ya llegó a 1000, no suma más
    if (globalPoints >= 1000) return;

    // Sumamos al total global
    globalPoints += energy;

    // 🟡 evitamos que pase de 1000
    if (globalPoints > 1000) {
      globalPoints = 1000;
    }

    // Actualizamos el estado (color)
    updateState();

    console.log("Puntos:", globalPoints);

    // EMITIR A TODOS LOS USUARIOS

    // Enviamos el nuevo estado a TODOS los conectados
    io.emit("stateUpdate", {
      points: globalPoints,
      color: currentColor
    });
  });

  // 🔄 RESET DEL SISTEMA
  socket.on("reset", () => {

    globalPoints = 0;
    currentColor = "orange";

    io.emit("stateUpdate", {
      points: globalPoints,
      color: currentColor
    });

    console.log("🔄 Reset ejecutado");
  });

  // DESCONEXIÓN
  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);
  });
});

// INICIAR SERVIDOR
server.listen(3000, () => {
  console.log("Servidor corriendo en http://localhost:3000");
});