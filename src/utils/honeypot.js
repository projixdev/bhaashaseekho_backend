// A real visitor never sees or fills the honeypot field (it's visually hidden
// off-screen in the form). Bots that blindly fill every input trip it.
export function isHoneypotTriggered(value) {
  return Boolean(value && value.trim().length > 0);
}
