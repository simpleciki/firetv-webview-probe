// The probe's Vega OS shell: the same pages as the Fire OS build, in Vega's WebView.
// Like the Fire OS shell it interprets nothing: it gives the page `window.ProbeNative`
// (info / setPlaying / exit) and reports what the app layer receives — React Native TV events
// and app state changes — as 'probe-native' events. The page decides what each step means.
import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useCallback, useEffect, useRef} from 'react';
import {
  AppState,
  BackHandler,
  Dimensions,
  PixelRatio,
  Platform,
  StyleSheet,
  View,
  useTVEventHandler,
} from 'react-native';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';
import flavor from './flavor.json';

type Report = {kind: string; [k: string]: unknown};

// What this device is, as far as the app layer can tell. The page adds its WebView version.
function info() {
  const s = Dimensions.get('screen');
  const scale = PixelRatio.get();
  const c = (Platform.constants || {}) as Record<string, unknown>;
  return {
    shell: 'vega',
    build: flavor.name,
    mediaControl: flavor.mediaControl,
    pageMedia: true, // voice steps play the page's own video: there is no shell media session here
    manufacturer: String(c.Manufacturer ?? c.manufacturer ?? ''),
    model: String(c.Model ?? c.model ?? ''),
    os: 'Vega OS ' + String(Platform.Version ?? ''),
    constants: c,
    displayPx: `${Math.round(s.width * scale)}x${Math.round(s.height * scale)}`,
  };
}

// window.ProbeNative for the page. info() must answer synchronously (the Fire OS bridge does),
// so the answer is written into the page before it loads.
function bridgeScript(): string {
  const send = 'function(m){window.ReactNativeWebView.postMessage(JSON.stringify(m));}';
  return `(function(){var send=${send};window.ProbeNative={
    info:function(){return ${JSON.stringify(JSON.stringify(info()))};},
    setPlaying:function(on){send({t:'setPlaying',on:!!on});},
    exit:function(){send({t:'exit'});}
  };})();true;`;
}

export const App = () => {
  const webRef = useRef<{injectJavaScript: (js: string) => void} | null>(null);
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const report = useCallback((o: Report) => {
    webRef.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('probe-native',{detail:${JSON.stringify(o)}}));true;`,
    );
  }, []);

  // Every remote event the app layer sees. With allowSystemKeyEvents on, Amazon documents that
  // system keys go to the web page only; the probe records whether that holds for each key.
  useTVEventHandler(evt => {
    report({
      kind: 'tv',
      type: evt.eventType,
      keyAction: evt.eventKeyAction ?? null,
      device: evt.deviceIdentifier ?? null,
    });
  });

  // The voice overlay may background the app; report it the way the Fire OS shell reports onPause.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      report({kind: 'lifecycle', event: state === 'active' ? 'onResume' : 'onPause', state});
    });
    return () => sub.remove();
  }, [report]);

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef as never}
        style={styles.webview}
        allowSystemKeyEvents
        allowsDefaultMediaControl
        domStorageEnabled
        hasTVPreferredFocus
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        source={{uri: 'file:///pkg/assets/index.html'}}
        injectedJavaScriptBeforeContentLoaded={bridgeScript()}
        onMessage={event => {
          let m: {t?: string; on?: boolean} = {};
          try {
            m = JSON.parse(event.nativeEvent.data);
          } catch (e) {
            return;
          }
          if (m.t === 'exit') BackHandler.exitApp();
          else if (m.t === 'setPlaying') report({kind: 'state', playing: !!m.on});
        }}
        onLoad={() => hideSplashScreenCallback()}
        onError={({nativeEvent: {code, url, description}}) => {
          console.error(`[probe] load error (${code}: ${url}) ${description}`);
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1},
  webview: {backgroundColor: '#11161c'},
});
