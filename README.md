# Galerie – virtuelle 3D-Fotogalerie

Begehbare Galerie im Browser (Three.js) mit mehreren Räumen, automatischer Wandbelegung und Detailansicht.

## Ablauf
1. **Bilder:** viele Fotos per Drag & Drop (auch ganze Ordner) hochladen, Tags vergeben.
2. **Räume & Wände:** Grundriss zeichnen (Raum ▭/⬠), Türen setzen, dann „Alle neu verteilen“.
   Bilder lassen sich danach an der Wand verschieben, in der Größe und Höhe ändern oder abhängen.
   Ein Raum mit einem Thema-Tag bekommt bevorzugt Bilder mit diesem Tag.
3. **Rundgang:** WASD + Maus (oder Joystick/Wischen auf dem Handy). Bild anklicken zeigt es ganz, Pfeile blättern, Esc schließt.

## Entwicklung
```
npm install
npm run dev      # Server :3000 + Vite :5173
```

## Betrieb (Docker, z. B. NAS)
```
docker compose up -d --build
```
Daten liegen im Volume `./data` (`original/`, `tex/`, `thumb/`, `gallery.json`). Für ein Backup diesen Ordner sichern.
Es gibt keinen Login, die Galerie gehört also nur ins Heimnetz oder hinter einen Reverse-Proxy mit Passwortschutz.

## QNAP Container Station
1. In der File Station `galerie.zip` in den Freigabeordner **Container** legen, Rechtsklick → **Extrahieren** → „Hierher extrahieren“.
   Ergebnis: `/Container/galerie/` mit `Dockerfile`, `server/`, `web/` usw.
2. Container Station öffnen → **Anwendungen** → **Erstellen**.
3. Anwendungsname `galerie`, den Inhalt von `docker-compose.qnap.yml` in das YAML-Feld einfügen → **Validieren** → **Erstellen**.
4. Der erste Start baut das Image (je nach NAS 5–15 Minuten, Internet nötig). Danach: `http://<NAS-IP>:3000`.

Belegt etwas anderes Port 3000, links in `"3000:3000"` eine andere Zahl eintragen (z. B. `"3080:3000"`).
Update: neuen ZIP-Inhalt über den alten Ordner extrahieren (der Ordner `data` bleibt), dann die Anwendung neu erstellen bzw. neu bauen.

## Testseite (statische Demo)
`npm run build:demo` baut aus `demo/` (24 Beispielfotos, 3 Räume) eine Seite in `demo-dist/`, die ohne Server läuft.
Bei jedem Push auf `main` baut GitHub die Seite automatisch und stellt sie über GitHub Pages bereit
(`.github/workflows/pages.yml`; einmalig unter Settings → Pages → Source „GitHub Actions“ wählen).
Für ein claude.ai-Artifact: `npm run build:demo -- --artifact`.
Die Demo-Fotos sind Ausschnitte aus Poly-Haven-Panoramen (CC0).

## Quellen
Texturen, Panorama und Modelle stammen von [Poly Haven](https://polyhaven.com) und sind CC0 (gemeinfrei):
- Texturen: `concrete_floor_worn_001`, `hangar_concrete_floor`, `wood_floor`, `plaster_grey_04` (1K) in `web/public/textures/`
- Panoramen: `meadow` (Tag) und `belfast_sunset` (Abend), verkleinert, als `web/public/textures/meadow.jpg` bzw. `evening.jpg`
- Demo-Fotos in `demo/`: Ausschnitte aus den Poly-Haven-Panoramen `blue_grotto`, `hamburg_canal`, `lakeside_dawn`, `lauter_waterfall`, `misty_pines`, `mossy_forest`, `piazza_san_marco`, `secluded_beach`, `snowy_forest_path_01`, `sunflowers`, `ulmer_muenster`, `venice_sunset`
- Modelle: `potted_plant_02`, `korean_fire_extinguisher_01`, `Ottoman_01` (als Bank gestreckt), `Camera_01`, `vintage_video_camera`, `postcard_set_01` (glTF 1K) in `web/public/models/`
- Besucherfiguren: KayKit Mannequin und Idle-Animationen von Kay Lousberg (CC0) in `web/public/models/kaykit/`
- Katalog-Blätteranimation: [page-flip](https://github.com/Nodlik/StPageFlip) (MIT), 3D: [three.js](https://threejs.org) (MIT).
  Beide sind im Browser-Code gebündelt; ihre Lizenztexte liegen in `web/public/THIRD_PARTY_LICENSES.txt` und werden mit ausgeliefert.
- Server: Express, Multer (MIT), sharp (Apache-2.0, nutzt libvips unter LGPL-3.0 – wird erst beim Docker-Bau geladen, nicht im Repo)
