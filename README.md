# Gaz's Radio Stations – browser version

Free rock, blues, jazz, soul, funk and indie radio from around the world.
Stations come from Radio Browser (https://www.radio-browser.info). No account or key is needed.

## Try it on your computer
Double-click `index.html`. It opens in your browser and plays straight away.

## Put it online with GitHub Pages
1. On github.com, create a new public repository (for example `gaz-radio`).
2. Click **Add file → Upload files** and drag in everything from this folder
   (all the files plus the `images` folder). Click **Commit changes**.
3. Go to **Settings → Pages**. Under "Branch" pick `main` and `/ (root)`, then **Save**.
4. After a minute or two the site is live at `https://<your-username>.github.io/gaz-radio/`.

## Add it to your iPad (or iPhone) Home Screen
This needs the GitHub Pages version (an https address). Opening the file directly won't install as an app.
1. Open the GitHub Pages address in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Launch it from the new "Gaz's Radio" icon. It opens full screen with no Safari bars.

Volume is controlled with the iPad's own buttons, so the slider is hidden there.
When you publish changes, the app picks them up next time it's opened (close and reopen it if it was already running).

## Changing the genres
Edit the `GENRES` list at the top of `app.js`. Each genre is a list of Radio Browser tags.

## Notes
- Only stations with secure (https) streams are listed, because GitHub Pages is https and browsers block
  insecure audio on secure pages.
- Favourites, the last genre and the volume are remembered in each browser on its own device.
