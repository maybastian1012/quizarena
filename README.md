# Quizarena

Quiz-App für Spieleabende: Intro-Show, Vorrundenspiele, Finale mit Vorsprung, Handys als Antwortgeräte und Buzzer,
Spielleiter-Steuerung per Handy.

Online: https://maybastian1012.github.io/quizarena/

## Aufbau

| Datei | Zweck |
|---|---|
| `index.html` | Laptop/TV: Übersicht, Editor, Spielleiter-Bildschirm |
| `play.html` | Handy: Rollenwahl, Mitspielen oder Spielleiter (per QR-Code) |
| `js/model.js` | Datenmodell, Fragetypen, Beispielquizze, Prüfung vor dem Start |
| `js/editor.js` | Editor (Spiele-Liste links, Fragen rechts, Vorschau) |
| `js/excel.js` | Excel-Import und Excel-Vorlage |
| `js/host.js` | Spielablauf, Wertung, Joker, Buzzer, Intro, Statistik (TV) |
| `js/gm.js` | Spielleiter-Ansicht auf dem Handy (Reiter Live/Ablauf/Punkte/Mehr) |
| `js/player.js` | Handy der Mitspieler |
| `js/net.js` | Verbindung über WebRTC (PeerJS) |
| `js/store.js`, `js/media.js` | Speicherung im Browser, Mediendateien |
| `js/sfx.js`, `js/ui.js` | Töne, Hilfsfunktionen |
| `serve.ps1` | Lokaler Testserver |
| `test.html` | Nur lokal: TV + zwei Handys + Spielleiter in einem Fenster (nicht hochladen) |

## Lokal testen

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Dann http://localhost:8765 öffnen. Testansicht: http://localhost:8765/test.html?code=CODE&layout=gm

## Ablauf eines Abends

Lobby (QR-Code, Selfie freiwillig) → Intro (Titel, Spieler einzeln vorgestellt) → Generalprobe (alle tippen „Bereit“)
→ Spieltafel → Spiele (Ankündigung, Fragen, Spielende, Zwischenstand) → Finale → Statistik → Siegerehrung

## Spielleiter-Handy

- Denselben QR-Code scannen → „Spielleiter“ → Passwort `12345` (Schutz gegen versehentliches Einloggen, kein echter Zugriffsschutz)
- **Live:** Hauptknopf, aktuelle Frage mit Lösung, Notiz, Antworten, Richtig/Falsch beim Buzzern, Freitext abhaken
- **Ablauf:** alle Spiele und Fragen, direkt zu einer Frage springen oder ein Spiel (neu) starten
- **Punkte:** Punkte, Richtige, Finalwerte korrigieren, Joker zurückgeben, Spieler entfernen
- **Mehr:** Pause, +10 s, Antworten schließen, Überspringen, Rückgängig, Ton, Intro überspringen, QR-Code am TV
- Solange ein Spielleiter-Handy verbunden ist, blendet der TV seine Steuerleiste aus (Maus bewegen oder H)

## Fragetypen

- Multiple Choice, Wahr/Falsch (antippen, dann bestätigen), Schätzfrage (Zahlenstrahl bei der Auflösung)
- Reihenfolge (zählt nur komplett richtig), Buzzer (falsch = −1, Frage vorbei)
- Hinweis-Raten: Hinweise erscheinen nacheinander; per Buzzer oder Freitext (falsch gebuzzert = für diese Frage raus)
- Bild aufdecken: Bild wird von verpixelt zu scharf; per Buzzer oder Freitext
- Freitext: alle tippen, Vorschlag automatisch (Tippfehler-tolerant), Spielleiter hakt ab
- Höher oder tiefer: Startwert bekannt, mehr oder weniger?
- Jede Frage: Bild, Video/Audio (mit Start/Ende) oder YouTube-Link, Moderationsnotiz

## Joker (Anzahl pro Abend beim Einrichten)

⚡ Verdoppeln · ½ 50:50 · ⏱ Zusatzzeit (+10 s)

## Excel

Startseite → „Excel-Vorlage“ herunterladen, ausfüllen, „Aus Excel“ importieren (oder im Editor unter „Allgemein“ ergänzen).
Die Vorlage enthält ein Blatt „Anleitung“ mit allen Spalten.

## Tasten am Laptop

Leertaste/Enter = nächster Schritt · R/X = Buzzer richtig/falsch · Strg+Z = Rückgängig · M = Ton · F = Vollbild · H = Leiste
