#pragma once

// Self-contained status/control page: arm/disarm buttons, siren state,
// and a free-text sensor-trigger simulator. No external assets. Polls
// /status every 2s via fetch() to stay current without a full reload.
// Placeholders {{ARMED}}, {{SIREN}} are substituted by
// LocalWebServer::renderPage() before the page is served.
const char LOCAL_WEB_PAGE_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alarm System</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #111; color: #eee;
         margin: 0; padding: 24px 16px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .status { font-size: 14px; color: #999; margin-bottom: 20px; }
  .status b { color: #eee; }
  .row { max-width: 400px; margin: 0 auto 24px; display: flex; gap: 10px; }
  button { flex: 1; padding: 14px; border-radius: 6px; border: none;
           font-size: 16px; font-weight: 600; }
  .arm { background: #2d7dff; color: white; }
  .disarm { background: #444; color: #eee; }
  .sim { max-width: 400px; margin: 0 auto; border-top: 1px solid #333; padding-top: 20px; }
  .sim label { display: block; font-size: 14px; color: #ccc; margin-bottom: 4px; }
  .sim input { width: 100%; box-sizing: border-box; padding: 10px;
               border-radius: 6px; border: 1px solid #444; background: #222;
               color: #eee; font-size: 16px; margin-bottom: 10px; }
  .sim button { width: 100%; background: #a33; color: white; }
  .note { color: #aaa; font-size: 13px; line-height: 1.4; min-height: 1.2em;
          margin: 8px 0 0; }
  .pair { max-width: 400px; margin: 24px auto 0; border-top: 1px solid #333;
          padding-top: 20px; }
  .pair p { color: #ccc; font-size: 14px; line-height: 1.4; margin: 0 0 12px; }
  .pair button { width: 100%; background: #663; color: white; }
</style>
</head>
<body>
<h1>Alarm System</h1>
<p class="status">Armed: <b id="armedStatus">{{ARMED}}</b> &middot;
   Siren: <b id="sirenStatus">{{SIREN}}</b></p>
<div class="row">
  <button class="arm" onclick="post('/arm')">Arm</button>
  <button class="disarm" onclick="post('/disarm')">Disarm</button>
</div>
<div class="sim">
  <label for="rfId">Simulate sensor trigger (rfId)</label>
  <input type="text" id="rfId" placeholder="0xA1B2C3">
  <button onclick="trigger()">Trigger</button>
  <p class="note" id="simNote"></p>
</div>
<div class="pair">
  <h2>Siren</h2>
  <p>Press SET on the siren until its lights come on, then start pairing.
     The siren beeps twice when it has paired. The alarm cannot hear
     sensors for 10 seconds while it transmits.</p>
  <button onclick="pairSiren()">Pair siren (10s)</button>
  <button onclick="sirenTest()">Sound siren (test)</button>
  <button class="disarm" onclick="sirenSilence()">Silence siren</button>
  <button onclick="pairRemote()">Pair remote (30s)</button>
  <p class="note" id="pairNote"></p>
</div>
<script>
  function post(path) {
    fetch(path, { method: 'POST' }).then(refresh);
  }
  function note(msg) {
    document.getElementById('simNote').textContent = msg;
  }
  function trigger() {
    var rfId = document.getElementById('rfId').value.trim();
    // Previously this returned silently on empty input, which made the
    // button look broken. Always say something.
    if (!rfId) { note('Enter a sensor rfId first, e.g. 0xA1B2C3'); return; }
    note('Sending ' + rfId + '...');
    fetch('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'rfId=' + encodeURIComponent(rfId)
    }).then(function(r) {
      if (!r.ok) { note('Trigger failed (HTTP ' + r.status + ')'); return; }
      // The event always reaches the alarm logic, but it only fires the
      // siren when the device is armed AND the rfId is a sensor in the
      // current config. An empty config (no cloud sync yet) means every id
      // is unknown and is ignored by design — say so, rather than looking
      // like nothing happened.
      note('Sent ' + rfId + '. Siren only fires if armed and this rfId is in'
           + ' the synced config.');
      refresh();
    }).catch(function() { note('Trigger failed (network error)'); });
  }
  function pairNote(msg) {
    document.getElementById('pairNote').textContent = msg;
  }
  function pairSiren() {
    pairNote('Pairing for 10s...');
    fetch('/pair-siren', { method: 'POST' }).then(function(r) {
      return r.text().then(function(t) {
        pairNote(t);
      });
    }).catch(function() { pairNote('Pairing request failed (network error)'); });
  }
  function pairRemote() {
    pairNote('Opening pairing window...');
    fetch('/pair-remote', { method: 'POST' }).then(function(r) {
      return r.text().then(function(t) {
        pairNote(t);
        // Poll /status so the outcome (paired / refused) lands in the note
        // without the user needing a serial console.
        setTimeout(function() {
          fetch('/status').then(function(s) { return s.json(); })
            .then(function(j) { pairNote('Pairing: ' + j.remote_pair); });
        }, 2000);
      });
    }).catch(function() { pairNote('Pair remote failed (network error)'); });
  }
  function sirenTest() {
    pairNote('Sounding the siren...');
    fetch('/siren-test', { method: 'POST' }).then(function(r) {
      return r.text().then(function(t) {
        pairNote(t);
        refresh();
      });
    }).catch(function() { pairNote('Siren test failed (network error)'); });
  }
  // Posts to /disarm deliberately rather than to a siren-only endpoint:
  // disarming is what silences the siren in this system, and routing the
  // button through the real path means pressing it exercises exactly the
  // behaviour we care about (disarm transmits the RF stop command).
  function sirenSilence() {
    pairNote('Silencing...');
    fetch('/disarm', { method: 'POST' }).then(function(r) {
      return r.text().then(function() {
        pairNote('Disarmed - siren silenced.');
        refresh();
      });
    }).catch(function() { pairNote('Silence failed (network error)'); });
  }
  function refresh() {
    fetch('/status').then(function(r) { return r.json(); }).then(function(s) {
      document.getElementById('armedStatus').textContent = s.armed ? 'yes' : 'no';
      document.getElementById('sirenStatus').textContent = s.siren ? 'ACTIVE' : 'off';
    });
  }
  setInterval(refresh, 2000);
</script>
</body>
</html>
)HTML";
