import app from "./app.js";
import { env } from "./config/env.js";
import { scheduleMonthlyReloginReminder } from "./jobs/monthlyReloginReminder.js";
import { scheduleClassReminders } from "./jobs/classReminders.js";

app.listen(env.port, () => {
  console.log(`Bhaasha Seekho backend listening on port ${env.port}`);
});

scheduleMonthlyReloginReminder();
scheduleClassReminders();
