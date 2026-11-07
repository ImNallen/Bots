import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("fire routines", { minutes: 1 }, internal.schedules.fireDue);

export default crons;
