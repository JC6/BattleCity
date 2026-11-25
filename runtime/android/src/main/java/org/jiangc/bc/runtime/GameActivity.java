package org.jiangc.bc.runtime;

import android.graphics.Rect;
import android.os.Bundle;
import android.widget.RelativeLayout;
import org.libsdl.app.SDLActivity;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

public final class GameActivity extends SDLActivity {
    private boolean showingMenu;
    private boolean measureSmallBuffer;
    private boolean smallBuffer;

    @Override
    protected void onCreate(Bundle state) {
        measureSmallBuffer = new File(getFilesDir(), "tv-low-buffer").isFile();
        super.onCreate(state);
        if (mLayout == null || mSurface == null) return;
        applyWallpaper(wallpaperMode(-1));
        mLayout.addOnLayoutChangeListener((view, l, t, r, b, oldL, oldT, oldR, oldB) ->
                resizeSurface(r - l, b - t));
    }

    // Called on the emulation thread by the shared player menu.
    public int screenMode(int requested) {
        android.content.SharedPreferences prefs = getSharedPreferences("display", MODE_PRIVATE);
        if (requested >= 0 && requested <= 3) {
            prefs.edit().putInt("mode", requested).apply();
            runOnUiThread(() -> resizeSurface(mLayout.getWidth(), mLayout.getHeight()));
        }
        return prefs.getInt("mode", 0);
    }

    public int pictureMode(int requested) {
        android.content.SharedPreferences prefs = getSharedPreferences("display", MODE_PRIVATE);
        if (requested >= 0 && requested <= 3) {
            prefs.edit().putInt("picture", requested).apply();
            if (measureSmallBuffer) runOnUiThread(() -> resizeSurface(mLayout.getWidth(), mLayout.getHeight()));
        }
        return prefs.getInt("picture", 0);
    }

    public int wallpaperMode(int requested) {
        android.content.SharedPreferences prefs = getSharedPreferences("display", MODE_PRIVATE);
        if (requested >= 0 && requested <= 3) {
            prefs.edit().putInt("wallpaper", requested).apply();
            runOnUiThread(() -> applyWallpaper(requested));
        }
        return prefs.getInt("wallpaper", 0);
    }

    private void applyWallpaper(int mode) {
        if (mode == 3) {
            mLayout.setBackgroundColor(android.graphics.Color.BLACK);
        } else {
            int image = mode == 1 ? R.drawable.battle_stars : mode == 2 ? R.drawable.battle_symbols : R.drawable.battle_surround;
            android.graphics.drawable.BitmapDrawable background =
                    (android.graphics.drawable.BitmapDrawable) getDrawable(image).mutate();
            background.setGravity(android.view.Gravity.FILL);
            background.setFilterBitmap(true);
            mLayout.setBackground(background);
        }
    }

    public void pairGamepads() {
        runOnUiThread(() -> {
            try {
                startActivity(new android.content.Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS));
            } catch (android.content.ActivityNotFoundException unavailable) {
                android.widget.Toast.makeText(this, "Open Bluetooth settings on your TV to pair a gamepad.",
                        android.widget.Toast.LENGTH_LONG).show();
            }
        });
    }

    public void showSystemMenu(boolean visible) {
        runOnUiThread(() -> {
            showingMenu = visible;
            resizeSurface(mLayout.getWidth(), mLayout.getHeight());
        });
    }

    private void resizeSurface(int width, int height) {
        if (width <= 0 || height <= 0) return;
        int mode = screenMode(-1);
        float aspect = mode == 2 ? 256f / 224 : 4f / 3;
        int screenWidth = mode == 3 ? width :
                Math.min(width, Math.round(height * (mode == 1 ? 1f : 0.83f) * aspect));
        int visible = mode == 3 ? height : Math.round(screenWidth / aspect);
        int full = Math.round(visible * 240f / 224);
        if (showingMenu) {
            screenWidth = Math.min(width, Math.round(height * 16f / 9));
            visible = full = Math.round(screenWidth * 9f / 16);
        }
        RelativeLayout.LayoutParams size = (RelativeLayout.LayoutParams) mSurface.getLayoutParams();
        if (size.width != screenWidth || size.height != full) {
            size.width = screenWidth;
            size.height = full;
            size.addRule(RelativeLayout.CENTER_IN_PARENT);
            mSurface.setLayoutParams(size);
        }
        boolean useSmall = measureSmallBuffer && !showingMenu && pictureMode(-1) == 0;
        if (smallBuffer != useSmall) {
            smallBuffer = useSmall;
            if (useSmall) mSurface.getHolder().setFixedSize(256, 240);
            else mSurface.getHolder().setSizeFromLayout();
        }
        int crop = (full - visible) / 2;
        mSurface.setClipBounds(new Rect(0, crop, screenWidth, crop + visible));
    }

    @Override
    protected String[] getLibraries() {
        return new String[] {"SDL3", "main"};
    }

    private void copyCompatibleSlots(File root, String current) throws IOException {
        String previous = null;
        try (InputStream input = getAssets().open("save-compatibility.tsv")) {
            String table = new String(input.readAllBytes(), java.nio.charset.StandardCharsets.US_ASCII);
            for (String line : table.split("\n")) {
                String[] ids = line.split(" ");
                if (ids.length == 2 && ids[0].equals(current) && ids[1].matches("[0-9a-f]{64}")) previous = ids[1];
            }
        }
        if (previous == null || previous.equals(current)) return;
        java.nio.file.Path states = root.toPath().resolve("states");
        java.nio.file.Path source = states.resolve(previous).resolve("nes");
        java.nio.file.Path target = states.resolve(current);
        if (!Files.isDirectory(source) || Files.exists(target)) return;
        java.nio.file.Path temp = Files.createTempDirectory(states, ".upgrade-");
        java.nio.file.Path saves = temp.resolve("nes");
        Files.createDirectory(saves);
        try {
            boolean copied = false;
            for (int slot = 1; slot <= 4; ++slot) {
                String name = slot + ".sta";
                if (!Files.isRegularFile(source.resolve(name))) continue;
                for (String suffix : new String[]{"", ".png", ".lock"}) {
                    java.nio.file.Path file = source.resolve(name + suffix);
                    if (Files.isRegularFile(file)) {
                        java.nio.file.Path copy = saves.resolve(name + suffix);
                        Files.copy(file, copy);
                        Files.setLastModifiedTime(copy, Files.getLastModifiedTime(file));
                    }
                }
                copied = true;
            }
            if (copied) Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            if (Files.isDirectory(saves)) {
                try (java.nio.file.DirectoryStream<java.nio.file.Path> files = Files.newDirectoryStream(saves)) {
                    for (java.nio.file.Path file : files) Files.delete(file);
                }
                Files.delete(saves);
            }
            Files.deleteIfExists(temp);
        }
    }

    @Override
    protected String[] getArguments() {
        File root = getFilesDir();
        File game = new File(root, "game.nes");
        String cartridgeId;
        try (InputStream id = getAssets().open("cartridge.id");
             InputStream stream = getAssets().open("game.nes")) {
            cartridgeId = new String(id.readAllBytes(), java.nio.charset.StandardCharsets.US_ASCII);
            Files.copy(stream, game.toPath(), StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException error) {
            throw new IllegalStateException("Cannot prepare the bundled cartridge", error);
        }
        try {
            copyCompatibleSlots(root, cartridgeId);
        } catch (IOException error) {
            android.util.Log.e("BattleCity", "Could not copy the previous saves", error);
        }
        File defaults = new File(root, "runtime-defaults");
        File config = new File(defaults, "mame.ini");
        String renderer = BuildConfig.TV_SURFACE ? "compositor-tv" : "none";
        try {
            Files.createDirectories(defaults.toPath());
            Files.write(config.toPath(), ("scalemode " + renderer + "\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        } catch (IOException error) {
            throw new IllegalStateException("Cannot prepare runtime defaults", error);
        }
        return new String[] {"nes", "-uifont", "battlecity-regular", "-cart", game.getPath(), "-skip_gameinfo", "-inipath", root.getPath() + ";" + defaults.getPath(),
            "-video", "soft", "-nokeepaspect", "-joystick", "-rewind", "-state_directory", new File(root, "states/" + cartridgeId).getPath(),
            "-cfg_directory", new File(root, "cfg").getPath()};
    }
}
