import { Queue, type JobsOptions } from 'bullmq';
import type Redis from 'ioredis';

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

export function createQueue(name: string, connection: Redis): Queue {
  return new Queue(name, { connection, defaultJobOptions });
}
