# Quizarena

Quiz-App für Spieleabende: Vorrundenspiele, Finale mit Vorsprung, Handys als Antwortgeräte.

## Aufbau

| Datei | Zweck |
|---|---|
| `index.html` | Laptop/TV: Übersicht, Editor, Spielleiter-Ansicht |
| `play.html` | Handy der Mitspieler (per QR-Code) |
| `js/model.js` | Datenmodell, Beispielquiz, Prüfung vor dem Start |
| `js/editor.js` | Editor für Spiele, Fragen, Finale, Stechfragen |
| `js/host.js` | Spielablauf und Wertung (Spielleiter) |
| `js/player.js` | Handy-Ansicht |
| `js/net.js` | Verbindung über WebRTC (PeerJS) |
| `js/store.js` | Speicherung im Browser (IndexedDB) |
| `serve.ps1` | Lokaler Testserver |

## Lokal testen

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Dann http://localhost:8765 öffnen. In der Lobby über „+ Test-Spieler öffnen“ Handy-Tabs simulieren.

## Bedienung am Abend

- Leertaste / Enter: Hauptaktion (nächster Schritt)
- F: Vollbild
- Quizze liegen im Browser des Laptops. Vor Browserwechsel oder Löschen der Browserdaten: exportieren.

## Wertung

- Fragespiel: Wer die meisten Fragen richtig hat, gewinnt das Spiel. Schätzfrage: wer am nächsten dran ist.
- Gleichstand: Stechfrage (eigene des Spiels, sonst aus dem Vorrat) oder Sieger direkt wählen.
- Finale: Vorrundenpunkte = Vorsprung. Modi: Zielpunktzahl, feste Fragenzahl oder Leben.
