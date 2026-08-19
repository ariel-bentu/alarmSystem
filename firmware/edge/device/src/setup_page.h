#pragma once

// Self-contained setup page: no external assets (AP has no internet).
// Placeholders {{ERROR_BANNER}}, {{SSID}}, {{ENDPOINT}}, {{DATABASE_URL}},
// {{API_KEY}} are substituted by ProvisioningPortal before the page is
// served.
const char SETUP_PAGE_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alarm System Setup</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #111; color: #eee;
         margin: 0; padding: 24px 16px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.sub { color: #999; margin-top: 0; font-size: 14px; }
  form { max-width: 400px; margin: 0 auto; }
  label { display: block; margin-top: 16px; font-size: 14px; color: #ccc; }
  select, input { width: 100%; box-sizing: border-box; padding: 10px;
                  margin-top: 4px; border-radius: 6px; border: 1px solid #444;
                  background: #222; color: #eee; font-size: 16px; }
  button { width: 100%; margin-top: 24px; padding: 12px; border-radius: 6px;
           border: none; background: #2d7dff; color: white; font-size: 16px;
           font-weight: 600; }
  .error { background: #4a1414; border: 1px solid #a33; color: #f5b5b5;
           padding: 10px 12px; border-radius: 6px; margin-top: 16px; font-size: 14px; }
  .manual-toggle { font-size: 13px; color: #7aa7ff; margin-top: 8px;
                    display: inline-block; }
</style>
</head>
<body>
<h1>Alarm System Setup</h1>
<p class="sub">Connect this device to your WiFi</p>
{{ERROR_BANNER}}
<form method="POST" action="/save">
  <label for="ssidSelect">WiFi network</label>
  <select id="ssidSelect" name="ssidSelect"><option value="">Scanning...</option></select>
  <a class="manual-toggle" id="manualToggle" href="#">Network not listed? Enter manually</a>
  <input type="text" id="ssidManual" name="ssid" placeholder="SSID"
         value="{{SSID}}" style="display:none; margin-top:8px;">

  <label for="password">WiFi password</label>
  <input type="password" id="password" name="password">

  <label for="endpoint">Alarm system endpoint</label>
  <input type="text" id="endpoint" name="endpoint" value="{{ENDPOINT}}"
         placeholder="https://...">

  <label for="databaseUrl">Realtime Database URL</label>
  <input type="text" id="databaseUrl" name="databaseUrl" value="{{DATABASE_URL}}"
         placeholder="https://<project>-default-rtdb.<region>.firebasedatabase.app">

  <label for="apiKey">API key</label>
  <input type="text" id="apiKey" name="apiKey" value="{{API_KEY}}">

  <button type="submit">Save &amp; Connect</button>
</form>
<script>
  var sel = document.getElementById('ssidSelect');
  var manual = document.getElementById('ssidManual');
  var toggle = document.getElementById('manualToggle');
  toggle.addEventListener('click', function(e) {
    e.preventDefault();
    var showManual = manual.style.display === 'none';
    manual.style.display = showManual ? 'block' : 'none';
    sel.style.display = showManual ? 'none' : '';
    sel.name = showManual ? '' : 'ssidSelect';
    manual.name = 'ssid';
  });
  fetch('/scan').then(function(r) { return r.json(); }).then(function(list) {
    sel.innerHTML = '';
    if (!list.length) {
      sel.innerHTML = '<option value="">No networks found</option>';
      return;
    }
    list.forEach(function(n) {
      var opt = document.createElement('option');
      opt.value = n.ssid;
      opt.textContent = n.ssid + ' (' + n.rssi + ' dBm)';
      sel.appendChild(opt);
    });
  }).catch(function() {
    sel.innerHTML = '<option value="">Scan failed — enter manually</option>';
  });
</script>
</body>
</html>
)HTML";
