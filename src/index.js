const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

dotenv.config();

const { connectDB, checkConnectionHealth } = require('./config/database');

const app = express();

// Trust proxy for production
app.set('trust proxy', 1);

// Connect to MongoDB
connectDB()
  .then(() => console.log('Database ready'))
  .catch((error) => {
    console.error('Failed to connect to database:', error.message);
    process.exit(1);
  });

// Security
app.use(helmet({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));
app.use(cookieParser());

// CORS
const corsOptions = {
  origin: [process.env.FRONTEND_URL || 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 600,
};
app.use(cors(corsOptions));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// Routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const billingRoutes = require('./routes/billingRoutes');
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/billing', billingRoutes);

// Health check
app.get('/health', (req, res) => {
  const db = checkConnectionHealth();
  res.status(db.isConnected ? 200 : 503).json({
    status: db.isConnected ? 'ok' : 'error',
    database: db.state,
    uptime: Math.floor(process.uptime()),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status || 500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// Start server
const PORT = process.env.PORT || 4001;
const server = app.listen(PORT, () => {
  console.log(`SupaRank server running on port ${PORT}`);
});

// Graceful shutdown
const cleanup = async () => {
  console.log('Shutting down...');
  server.close();
  const mongoose = require('mongoose');
  await mongoose.connection.close();
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

module.exports = app;
