/**
 * The diary's settings: where its spirit lives, and how it writes.
 * E-ink: black on white, large targets, no animation.
 */

import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {NativeUIUtils, PluginManager} from 'sn-plugin-lib';

import {native} from './src/files';
import {currentStage, subscribeStage} from './src/stage';
import StageView from './src/StageView';
import {recentLog} from './src/log';
import * as memory from './src/memory';
import {ask, OracleError} from './src/oracle';
import {buildMessages, cleanProse} from './src/prompt';
import {loadSettings, saveSettings, DEFAULTS, type ImageMode, type Reveal, type Settings} from './src/settings';

const REVEALS: {label: string; value: Reveal}[] = [
  {label: 'Letter by letter', value: 'quill'},
  {label: 'Line by line', value: 'line'},
  {label: 'All at once', value: 'all'},
];

const IMAGE_MODES: {label: string; value: ImageMode}[] = [
  {label: 'Auto', value: 'auto'},
  {label: 'Always', value: 'always'},
  {label: 'Never', value: 'never'},
];

type Choice<T> = {label: string; value: T};

function Choices<T>({value, options, onPick}: {value: T; options: Choice<T>[]; onPick: (v: T) => void}) {
  return (
    <View style={styles.choices}>
      {options.map(o => (
        <Pressable key={o.label} onPress={() => onPick(o.value)} style={[styles.choice, o.value === value && styles.chosen]}>
          <Text style={[styles.choiceText, o.value === value && styles.chosenText]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Field({label, hint, children}: {label: string; hint?: string; children: React.ReactNode}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function Button({title, onPress, primary}: {title: string; onPress: () => void; primary?: boolean}) {
  return (
    <Pressable onPress={onPress} style={[styles.button, primary && styles.primary]}>
      <Text style={[styles.buttonText, primary && styles.primaryText]}>{title}</Text>
    </Pressable>
  );
}

/** The plugin view is either the diary's stage (over the page) or the settings. */
export default function App(): React.JSX.Element {
  const [stage, setStage] = useState(currentStage());
  useEffect(() => subscribeStage(() => setStage(currentStage())), []);
  return stage ? <StageView stage={stage} /> : <SettingsScreen />;
}

function SettingsScreen(): React.JSX.Element {
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [status, setStatus] = useState('');
  const [pages, setPages] = useState(0);

  useEffect(() => {
    loadSettings().then(setS);
    memory.count().then(setPages);
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setS(prev => ({...prev, [key]: value}));

  const save = async () => {
    const ok = await saveSettings(s);
    setStatus(ok ? 'Saved.' : native ? 'Could not save the settings.' : 'Saved for this session only (file module missing).');
  };

  const test = async () => {
    setStatus('Writing "Hello?" to the spirit…');
    try {
      const raw = await ask(
        {baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, reasoning: s.reasoning, maxTokens: s.maxTokens},
        buildMessages({transcript: 'Hello? Is anyone there?', history: [], catalog: [], remember: false}),
      );
      setStatus(`The spirit answers: ${cleanProse(raw)}`);
    } catch (e) {
      setStatus(e instanceof OracleError ? `${e.spoken}\n(${e.message})` : String(e));
    }
  };

  const forget = async () => {
    const sure = await NativeUIUtils.showRattaDialog('Forget every page the diary remembers?', 'Keep them', 'Forget', false);
    if (sure) {
      await memory.forget();
      setPages(0);
      setStatus('The diary has forgotten everything.');
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>The Diary</Text>
        <Button title="Close" onPress={() => PluginManager.closePluginView()} />
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          Write in a note whose name contains "{s.noteMatch}". Then rest the pen on your last stroke, or tap the diary's button. Your ink sinks
          into the page and Tom answers.
        </Text>

        <Text style={styles.section}>The spirit</Text>
        <Field label="Server" hint="The diary bridge on your Mac or Pi, e.g. http://192.168.1.20:8787/v1 — or any OpenAI-compatible URL (Ollama: http://<ip>:11434/v1).">
          <TextInput style={styles.input} value={s.baseUrl} onChangeText={v => set('baseUrl', v)} autoCapitalize="none" autoCorrect={false} placeholder="http://192.168.1.20:8787/v1" />
        </Field>
        <Field label="Key" hint="The bridge's token, or an API key. Leave empty if none.">
          <TextInput style={styles.input} value={s.apiKey} onChangeText={v => set('apiKey', v)} autoCapitalize="none" autoCorrect={false} secureTextEntry />
        </Field>
        <Field label="Model" hint='With the bridge: "claude", "claude-sonnet", "gemma4:e2b"… With Ollama directly: gemma4:e2b.'>
          <TextInput style={styles.input} value={s.model} onChangeText={v => set('model', v)} autoCapitalize="none" autoCorrect={false} />
        </Field>
        <Field label="Show the spirit the page" hint="Auto: only when the tablet cannot read words (a drawing). Always: vision models see your hand.">
          <Choices value={s.imageMode} onPick={v => set('imageMode', v)} options={IMAGE_MODES} />
        </Field>
        <View style={styles.row}>
          <Button title="Test the spirit" onPress={test} />
        </View>

        <Text style={styles.section}>Writing</Text>
        <Field label="Rest the pen to hand over the page" hint="Hold the pen still on your last stroke this long. Off: use the button only.">
          <Choices value={s.holdMs} onPick={v => set('holdMs', v)} options={[{label: 'Off', value: 0}, {label: '0.8 s', value: 800}, {label: '1.2 s', value: 1200}, {label: '2 s', value: 2000}]} />
        </Field>
        <Field label="Tom's hand">
          <Choices value={s.inkScale} onPick={v => set('inkScale', v)} options={[{label: 'Small', value: 0.045}, {label: 'Medium', value: 0.057}, {label: 'Large', value: 0.07}]} />
        </Field>
        <Field label="Ink">
          <Choices value={s.inkWidth} onPick={v => set('inkWidth', v)} options={[{label: 'Fine', value: 200}, {label: 'Medium', value: 300}, {label: 'Bold', value: 400}]} />
        </Field>
        <Field label="Tom's reply appears" hint="Letter by letter: Tom writes on the page and his words fade away, like riddle (they are remembered). Line by line / All at once: his reply stays in the note as ink (slower).">
          <Choices value={s.reveal} onPick={v => set('reveal', v)} options={REVEALS} />
        </Field>
        <Field label="Your ink fades before it vanishes">
          <Choices value={s.fade} onPick={v => set('fade', v)} options={[{label: 'Fade', value: true}, {label: 'Vanish', value: false}]} />
        </Field>
        <Field label="Diary notes" hint="The diary only ever drinks ink in notes whose file name contains this word.">
          <TextInput style={styles.input} value={s.noteMatch} onChangeText={v => set('noteMatch', v)} autoCapitalize="none" autoCorrect={false} />
        </Field>

        <Text style={styles.section}>Memory</Text>
        <Field label="The diary remembers" hint={`Pages kept on this tablet: ${pages}. Tom follows the conversation, and "show me…" conjures an old page.`}>
          <Choices value={s.remember} onPick={v => set('remember', v)} options={[{label: 'On', value: true}, {label: 'Off', value: false}]} />
        </Field>
        <View style={styles.row}>
          <Button title="Forget everything" onPress={forget} />
        </View>

        <View style={styles.row}>
          <Button title="Save" onPress={save} primary />
        </View>
        {status ? <Text style={styles.status}>{status}</Text> : null}

        <Text style={styles.section}>Recent</Text>
        <Text style={styles.log}>{recentLog().slice(-12).join('\n') || 'Nothing yet.'}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 32, paddingVertical: 20, borderBottomWidth: 2, borderColor: '#000'},
  title: {fontSize: 40, fontWeight: '700', color: '#000', fontStyle: 'italic'},
  body: {padding: 32, paddingBottom: 120},
  intro: {fontSize: 24, color: '#000', lineHeight: 34, marginBottom: 16},
  section: {fontSize: 28, fontWeight: '700', color: '#000', marginTop: 28, marginBottom: 8, borderBottomWidth: 1, borderColor: '#000', paddingBottom: 6},
  field: {marginVertical: 10},
  label: {fontSize: 24, color: '#000', fontWeight: '600', marginBottom: 8},
  hint: {fontSize: 20, color: '#333', marginTop: 6, lineHeight: 28},
  input: {fontSize: 24, color: '#000', borderWidth: 2, borderColor: '#000', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10},
  choices: {flexDirection: 'row', flexWrap: 'wrap'},
  choice: {borderWidth: 2, borderColor: '#000', borderRadius: 8, paddingHorizontal: 20, paddingVertical: 12, marginRight: 12, marginBottom: 8},
  chosen: {backgroundColor: '#000'},
  choiceText: {fontSize: 22, color: '#000'},
  chosenText: {color: '#fff', fontWeight: '700'},
  row: {flexDirection: 'row', marginVertical: 12},
  button: {borderWidth: 2, borderColor: '#000', borderRadius: 8, paddingHorizontal: 24, paddingVertical: 14},
  primary: {backgroundColor: '#000'},
  buttonText: {fontSize: 24, color: '#000', fontWeight: '600'},
  primaryText: {color: '#fff'},
  status: {fontSize: 22, color: '#000', marginTop: 8, lineHeight: 32},
  log: {fontSize: 16, color: '#000', fontFamily: 'monospace', lineHeight: 22},
});
