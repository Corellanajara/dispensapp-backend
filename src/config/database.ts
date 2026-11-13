import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { migrarBdSiCorresponde } from './migrarBd';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/dispensarios';

export const connectDB = async (): Promise<void> => {
  try {
    const uri = (await migrarBdSiCorresponde(MONGODB_URI)) ?? MONGODB_URI;
    await mongoose.connect(uri);
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB error:', err);
});
