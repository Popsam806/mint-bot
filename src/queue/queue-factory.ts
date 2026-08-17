import { Queue, type JobsOptions } from 'bullmq';
import type Redis from 'ioredis';

export const defaultJobOptions: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

export function createQueue(name: string, connection: Redis): Queue {
  return new Queue(name, { connection, defaultJobOptions });
}
