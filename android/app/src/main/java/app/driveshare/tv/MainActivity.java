package app.driveshare.tv;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * DriveShare for Android TV / Google TV: the DriveShare website, full screen, with the remote's
 * D-pad delivered to the page as arrow keys (a TV browser would turn it into a mouse pointer).
 * Every screen is the website, so updating the site updates the app.
 *
 * The page recognises the app by "DriveShareTV/" in the user agent: it shows its TV layout and
 * signs in with the QR code (Google does not allow its sign-in page inside apps' web views).
 */
public class MainActivity extends Activity {
    private WebView web;
    private FrameLayout root;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenDone;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0d0f12"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0d0f12"));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " DriveShareTV/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (Uri.parse(BuildConfig.SITE).getHost().equals(u.getHost())) return false;
                // Anything else (a Drive link): hand it to another app if the TV has one.
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback done) {
                fullscreen = view;
                fullscreenDone = done;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
            @Override
            public void onHideCustomView() { leaveFullscreen(); }
        });

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(BuildConfig.SITE + "/drive");
        web.requestFocus();
    }

    private void leaveFullscreen() {
        if (fullscreen == null) return;
        root.removeView(fullscreen);
        fullscreen = null;
        if (fullscreenDone != null) fullscreenDone.onCustomViewHidden();
        fullscreenDone = null;
        web.requestFocus();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        // Back: the page goes up a level (it answers whether it did); at the top, the app closes.
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP) {
                if (fullscreen != null) { leaveFullscreen(); return true; }
                web.evaluateJavascript("window.__dsBack ? window.__dsBack() : false", handled -> {
                    if (!"true".equals(handled)) finish();
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }
}
