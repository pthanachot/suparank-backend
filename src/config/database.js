const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    mongoose.set('strictQuery', false);

    const options = {
      dbName: process.env.DB_NAME || 'suparank',
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 60000,
      retryWrites: true,
      retryReads: true,
    };

    console.log(`Connecting to MongoDB (${options.dbName})...`);
    const conn = await mongoose.connect(process.env.MONGODB_URI, options);
    console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    throw error;
  }
};

const checkConnectionHealth = () => {
  const state = mongoose.connection.readyState;
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

  return {
    state: states[state] || 'unknown',
    isConnected: state === 1,
    host: mongoose.connection.host,
    name: mongoose.connection.name,
  };
};

module.exports = { connectDB, checkConnectionHealth };
