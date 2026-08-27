import mongoose from 'mongoose';

/** Single source of truth for "is Mongo connected" across the jobs engine. */
export function mongoReady() {
  return mongoose.connection.readyState === 1;
}
