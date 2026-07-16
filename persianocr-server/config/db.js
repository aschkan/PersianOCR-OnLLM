const mongoose = require('mongoose');

/**
 * Connect to MongoDB. PersianOCR-OnLLM shares the same MongoDB box as the
 * sibling platforms (its own `persianocr` database), so its data is picked up by
 * the reverse-proxy db-history backups automatically.
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Mongoose 8 no longer needs the legacy options.
    });
    console.log(`✅  MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`❌  MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

// Graceful disconnect on app termination
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed (SIGINT).');
  process.exit(0);
});

module.exports = connectDB;
