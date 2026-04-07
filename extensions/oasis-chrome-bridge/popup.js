/**
 * Popup script — shows connection status by pinging the dev-agent WS.
 */
(async () => {
  const dot = document.getElementById("dot");
  const status = document.getElementById("status");

  try {
    // Try to reach the dev-agent health endpoint
    const res = await fetch("http://localhost:8008/health", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      // Check if the background WS is connected via badge
      const badgeText = await chrome.action.getBadgeText({});
      if (badgeText === "ON") {
        dot.classList.add("connected");
        status.innerHTML = "<strong>Connected</strong> to dev-agent (localhost:8008)";
      } else {
        status.innerHTML = "Dev-agent reachable but <strong>WebSocket reconnecting...</strong>";
      }
    } else {
      status.innerHTML = "Dev-agent returned <strong>error</strong> (port 8008)";
    }
  } catch {
    status.innerHTML = "Dev-agent <strong>not reachable</strong> on localhost:8008";
  }
})();
