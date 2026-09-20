import unittest
import toolkits as tk


class AtomicComponentsTests(unittest.TestCase):
    def test_audio_sources(self):
        self.assertEqual(tk.Audio().schema()['sources'], ['upload', 'microphone', 'system'])
        self.assertEqual(tk.Audio(sources=['system']).schema()['sources'], ['system'])
        self.assertEqual(tk.Audio(sources=['upload']).schema()['sources'], ['upload'])
        with self.assertRaises(ValueError):
            tk.Audio(sources=['unknown'])

    def test_typed_roundtrip_and_defaults(self):
        components = [tk.Number(minimum=0, maximum=1, value=0.5),
                      tk.Select(choices=['a', 'b'], multiple=True), tk.Table(columns=['name', 'score'])]
        ui = tk.Interface(lambda *values: values, components, components)
        values = [0.75, ['b'], [['sample', 0.75]]]
        self.assertEqual(ui.invoke(values, '.'), values)
        self.assertEqual(components[1].schema()['value'], [])
        self.assertEqual(tk.Select(choices=['a', 'b']).schema()['value'], 'a')

    def test_invalid_values_and_callback_results(self):
        for component, invalid in [(tk.Number(minimum=0, maximum=1), [True, float('nan'), 2, '1']),
                                   (tk.Select(choices=['a']), ['b', [], None]),
                                   (tk.Select(choices=['a'], multiple=True), [['a', 'a'], 'a']),
                                   (tk.Table(columns=['x']), [[[1, 2]], [[{}]], [[float('inf')]]])]:
            for value in invalid:
                with self.subTest(component=component.kind, value=value):
                    with self.assertRaises(ValueError):
                        tk.Interface(lambda x: x, component, component).invoke([value], '.')
                    with self.assertRaises(ValueError):
                        tk.Interface(lambda: value, [], component).invoke([], '.')

    def test_select_labels_and_empty_choices(self):
        select = tk.Select('音色', choices={'voice-id': '自然女声'})
        self.assertEqual(select.schema()['labels'], {'voice-id': '自然女声'})
        self.assertEqual(select.validate('voice-id'), 'voice-id')
        with self.assertRaises(ValueError): select.validate('自然女声')
        empty = tk.Select('音色', choices={}, placeholder='请配置音色')
        self.assertIsNone(empty.value)
        with self.assertRaisesRegex(ValueError, '请配置音色'): empty.validate(None)

    def test_audio_transcript_roundtrip(self):
        import base64
        import tempfile
        ui = tk.Interface(lambda request: request['main'].transcript,
                          [{'main': tk.Audio(transcript=True)}], tk.Text())
        with tempfile.TemporaryDirectory() as directory:
            value = {'data': base64.b64encode(b'audio').decode(), 'transcript': '参考文本'}
            self.assertEqual(ui.invoke([{'main': value}], directory), ['参考文本'])
            value['transcript'] = 123
            with self.assertRaises(ValueError): ui.invoke([{'main': value}], directory)

    def test_file_roundtrip_and_optional_file(self):
        import base64
        import tempfile
        ui = tk.Interface(lambda request: (request['main'].name, request['main'].path.read_text()),
                          [{'main': tk.File('资料', accept='.txt')}], [tk.Text(), tk.Text()])
        with tempfile.TemporaryDirectory() as directory:
            value = {'name': '../notes.txt', 'mimeType': 'text/plain', 'data': base64.b64encode('内容'.encode()).decode()}
            self.assertEqual(ui.invoke([{'main': value}], directory), ['notes.txt', '内容'])
        optional = tk.Interface(lambda request: 'empty' if request['main'] is None else 'present',
                                [{'main': tk.File(required=False)}], tk.Text())
        self.assertEqual(optional.invoke([{'main': None}], '.'), ['empty'])
