/**
 * The Diary — riddle (github.com/MaximeRivest/riddle) for the Supernote.
 *
 * Write in a note called "Diary…", then rest the pen on your last stroke for a
 * moment (or tap the diary's button): the diary drinks your ink and Tom
 * answers in his own hand.
 *
 * Listeners live at module scope: component listeners die when the plugin
 * view closes, and the diary works with its view closed.
 *
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';

import App from './App';
import {name as appName} from './app.json';
import {pen, takePage} from './src/diary';
import {RestGate} from './src/hold';
import {log} from './src/log';
import {loadSettings, settings} from './src/settings';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

const DIARY_BUTTON = 701;

PluginManager.registerButton(1, ['NOTE'], {
  id: DIARY_BUTTON,
  name: 'The Diary',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 0,
}).catch(e => log(`registerButton: ${String(e)}`));

PluginManager.registerButtonListener({
  onButtonPress(event) {
    if (event?.id !== DIARY_BUTTON) {
      return;
    }
    // On a page with nothing written, the button opens the diary's settings.
    takePage('button').then(outcome => {
      if (outcome === 'empty') {
        PluginManager.showPluginView();
      }
    });
  },
});

PluginManager.registerConfigButton();
PluginManager.registerConfigButtonListener({
  onClick() {
    PluginManager.showPluginView();
  },
});

// Resting the pen: the stroke (event_pen_up) and the motion UP that carries the
// rest duration arrive separately; the gate pairs them.
const gate = new RestGate(() => settings().holdMs);

PluginManager.registerMotionListener(1, {
  onMsg(e) {
    const rested = pen.feed(e);
    if (rested !== null && gate.onLift(rested, Date.now())) {
      takePage('rest');
    }
  },
});

PluginManager.registerEventListener('event_pen_up', 1, {
  onMsg(elements) {
    const last = Array.isArray(elements) ? elements[elements.length - 1] : undefined;
    if (gate.onStroke(last?.stroke?.penType, Date.now())) {
      takePage('rest');
    }
  },
});

loadSettings().then(s => log(`ready: spirit at ${s.baseUrl || '(not set)'}, model ${s.model}, rest ${s.holdMs} ms`));
