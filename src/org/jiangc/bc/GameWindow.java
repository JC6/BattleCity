package org.jiangc.bc;

import android.graphics.Insets;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

/** Keep content inside system insets and a five-percent game safe area. */
final class GameWindow {
    private GameWindow() { }

    static void install(Window window, View root) {
        window.setDecorFitsSystemWindows(false);
        Insets[] insets = {Insets.NONE};
        root.setOnApplyWindowInsetsListener((view, applied) -> {
            insets[0] = applied.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            pad(view, insets[0]);
            return applied;
        });
        root.addOnLayoutChangeListener((view, l, t, r, b, ol, ot, or, ob) -> pad(view, insets[0]));
        root.requestApplyInsets();
        hideSystemBars(window);
    }

    static void hideSystemBars(Window window) {
        WindowInsetsController controller = window.getInsetsController();
        if (controller != null) {
            controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsets.Type.systemBars());
        }
    }

    private static void pad(View view, Insets insets) {
        int x = Math.max(0, view.getWidth() - insets.left - insets.right) / 20;
        int y = Math.max(0, view.getHeight() - insets.top - insets.bottom) / 20;
        int left = insets.left + x, top = insets.top + y;
        int right = insets.right + x, bottom = insets.bottom + y;
        if (view.getPaddingLeft() != left || view.getPaddingTop() != top
                || view.getPaddingRight() != right || view.getPaddingBottom() != bottom) {
            view.setPadding(left, top, right, bottom);
        }
    }
}
