# Quizarena

Quiz-App für Spieleabende: Vorrundenspiele, Finale mit Vorsprung, Handys als Antwortgeräte und Buzzer.

Online: https://maybastian1012.github.io/quizarena/

## Aufbau

| Datei | Zweck |
|---|---|
| `index.html` | Laptop/TV: Übersicht, Editor, Spielleiter-Ansicht |
| `play.html` | Handy der Mitspieler (per QR-Code) |
| `js/model.js` | Datenmodell, Beispielquizze, Prüfung vor dem Start |
| `js/editor.js` | Editor für Spiele, Fragen, Medien, Finale, Stechfragen |
| `js/host.js` | Spielablauf, Wertung, Joker, Buzzer (Spielleiter) |
| `js/player.js` | Handy-Ansicht (Rollenwahl, Spieler) |
| `js/gm.js` | Spielleiter-Ansicht auf dem Handy |
| `js/net.js` | Verbindung über WebRTC (PeerJS) |
| `js/store.js` | Speicherung im Browser (IndexedDB) |
| `js/media.js` | Video-/Audiodateien speichern, exportieren, aufräumen |
| `js/sfx.js` | Soundeffekte (im Browser erzeugt) |
| `serve.ps1` | Lokaler Testserver |
| `test.html` | Nur lokal: Spielleiter + zwei Handys in einem Fenster (nicht hochladen) |

## Lokal testen

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Dann http://localhost:8765 öffnen. In der Lobby über „+ Test-Spieler öffnen“ Handy-Tabs simulieren,
oder http://localhost:8765/test.html?code=CODE für alles in einem Fenster.

## Bedienung am Abend

- Leertaste / Enter: Hauptaktion (nächster Schritt)
- R / X: Buzzer-Antwort richtig / falsch
- M: Ton an/aus · F: Vollbild
- Quizze und Mediendateien liegen im Browser des Laptops. Vor Browserwechsel oder Löschen der Browserdaten: exportieren
  (die Exportdatei enthält auch hochgeladene Videos/Audios).

## Spielleiter-Handy

- Denselben QR-Code scannen → „Spielleiter“ → Passwort `12345`
  (Schutz gegen versehentliches Einloggen, kein echter Zugriffsschutz)
- Zeigt Lösung, Moderationsnotiz, Live-Antworten (wer hat was getippt), Vorschau auf die nächste Frage
- Steuert alles: Weiter, Auflösen, Buzzer werten, Pause, +10 s, Überspringen, Rückgängig, Spiele starten,
  Sieger wählen, Punkte/Richtige/Finalwerte korrigieren, Spieler entfernen
- Solange ein Spielleiter-Handy verbunden ist, blendet der TV die Steuerleiste aus (Maus bewegen oder H holt sie zurück)
- Laptop-Tasten: Strg+Z = Rückgängig

## Fragetypen

- Multiple Choice, Wahr/Falsch (Antwort antippen, dann bestätigen), Schätzfrage
- Reihenfolge: zählt nur, wenn die komplette Reihenfolge stimmt
- Buzzer: wer zuerst drückt, antwortet laut; Spielleiter wertet. Falsch = −1 und die Frage ist vorbei
- Jede Frage kann ein Bild, eine Video-/Audiodatei oder einen YouTube-Link haben
  (Start/Ende einstellbar, optional „erst abspielen, dann Antworten freigeben“)
- Jede Frage kann eine Moderationsnotiz haben (nur auf dem Spielleiter-Handy sichtbar)

## Joker (Anzahl pro Abend beim Einrichten)

- ⚡ Verdoppeln: nach der Spielankündigung am Handy setzen, Sieg zählt doppelt
- ½ 50:50: Multiple Choice, die Hälfte der falschen Antworten verschwindet
- ⏱ Zusatzzeit: 10 Sekunden mehr bei einer Frage

## Wertung

- Fragespiel: Wer die meisten Fragen richtig hat, gewinnt das Spiel. Schätzfrage: wer am nächsten dran ist.
- Gleichstand: Stechfrage (eigene des Spiels, sonst aus dem Vorrat) oder Sieger direkt wählen.
- Finale: Vorrundenpunkte = Vorsprung. Modi: Zielpunktzahl, feste Fragenzahl oder Leben.
