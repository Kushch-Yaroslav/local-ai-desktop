// The maintained native acceptance suite replaces the former scaled-canvas input test.
// It uses real Electron/preload/Main, physical XTest input, same-Page ownership and native navigation.
await import('./native-browser.test.mjs');
