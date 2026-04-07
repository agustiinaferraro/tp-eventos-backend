const config = {
  serverUrl: process.env.SERVER_URL || "http://localhost:3000",
  port: process.env.PORT || 3000,
  mongodbUri: process.env.MONGODB_URI || "mongodb+srv://AgustinaFerraro:Justin2019@ecommerce.br6mvoa.mongodb.net/?appName=ecommerce"
};

module.exports = config;
