// Calls Expo's push API directly (no expo-server-sdk dependency) — same
// choice already made for brevoService.js, one fewer dependency to track.
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Expo rejects a request with more than 100 messages in one call — batching
// here means callers never have to think about that limit themselves.
const BATCH_SIZE = 100;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// tokens: string[] of Expo push tokens ("ExponentPushToken[...]"). Best-
// effort per batch — one failed batch is logged and skipped rather than
// aborting the whole run, since this is fired from a cron job with no user
// waiting on a response (see jobs/monthlyReloginReminder.js).
export async function sendPushNotifications(tokens, { title, body, data } = {}) {
  const batches = chunk(tokens, BATCH_SIZE);

  for (const batch of batches) {
    const messages = batch.map((to) => ({
      to,
      title,
      body,
      // sound only actually does anything on iOS — Android's sound comes
      // from the "default" channel's own config (registerForPushNotific-
      // ationsAsync), not this field, but it's harmless to send either way.
      sound: "default",
      // Without this, Expo/FCM treats these as "normal" priority, which on
      // a sleeping/Doze-mode Android device can be delayed by a long time
      // or dropped outright — this was very likely why messaging pushes
      // weren't showing up on Android at all in testing.
      priority: "high",
      channelId: "default",
      ...(data ? { data } : {}),
    }));

    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Expo push API error ${response.status}: ${errorText}`);
      }
    } catch (err) {
      console.error("Expo push batch failed:", err);
    }
  }
}
