import base64
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request

import toolkits as tk
from toolkits.server import make_server


class InputGroupsTests(unittest.TestCase):
    def test_input_object_and_submission_policy(self):
        grouped = tk.Interface(lambda value: value['main'], tk.Input(tk.Text(), (tk.Number(value=1),)), tk.Text())
        self.assertEqual(grouped.schema()['input_mode'], 'grouped')
        self.assertEqual(grouped.schema()['submit'], 'manual')
        self.assertEqual(grouped.invoke([{'main': 'hello', 'additional': [2]}], '.'), ['hello'])
        self.assertEqual(tk.Interface(lambda value: '', tk.Input(tk.Audio()), tk.Text()).schema()['submit'], 'audio')
        self.assertEqual(tk.Interface(lambda value: '', tk.Input(tk.Audio()), tk.Text(), submit='manual').schema()['submit'], 'manual')
        self.assertEqual(tk.Interface(lambda a,b: '', [tk.Input(tk.Audio()), tk.Input(tk.Audio())], tk.Text()).schema()['submit'], 'manual')
        with self.assertRaises(ValueError):
            tk.Interface(lambda x: x, tk.Text(), tk.Text(), submit='audio')

    def test_groups_keep_order_and_audio_paths_distinct(self):
        async def process(a, b):
            self.assertEqual(a['main'].path.read_bytes(), b'audio-a')
            self.assertEqual(a['additional'], ['note', 1.25])
            self.assertEqual(b['main'].path.read_bytes(), b'audio-b')
            self.assertNotEqual(a['main'].path, b['main'].path)
            self.assertEqual(b['additional'], [])
            return 'ok'
        ui = tk.Interface(process, [
            {'main': tk.Audio('A'), 'additional': [tk.Text(), tk.Number(minimum=0.5, maximum=2)]},
            {'main': tk.Audio('B')},
        ], tk.Text())
        def audio(data):
            return {'name': 'same.wav', 'data': base64.b64encode(data).decode()}
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(ui.invoke([
                {'main': audio(b'audio-a'), 'additional': ['note', 1.25]},
                {'main': audio(b'audio-b')},
            ], directory), ['ok'])
        self.assertEqual(ui.schema()['inputs'][1]['additional'], [])

    def test_rejects_invalid_group_shapes_before_callback(self):
        for inputs in [[{'additional': []}], [{'main': tk.Text(), 'extra': []}],
                       [{'main': tk.Text(), 'additional': tk.Text()}],
                       [{'main': tk.Text()}, tk.Text()], [{'main': 'invalid'}],
                       [{'main': tk.Text(), 'additional': [tk.AudioInfo()]}]]:
            with self.subTest(inputs=inputs), self.assertRaises((TypeError, ValueError)):
                tk.Interface(lambda *_: None, inputs, tk.Text())
        def should_not_run(*_):
            self.fail('Invalid values reached callback')
        ui = tk.Interface(should_not_run, [{'main': tk.Text(), 'additional': [tk.Number(minimum=0)]}], tk.Text())
        for values in [[], ['flat'], [{'main': 'x'}], [{'main': 'x', 'additional': None}],
                       [{'main': 'x', 'additional': [-1]}],
                       [{'main': 'x', 'additional': [1, 2]}],
                       [{'main': 'x', 'additional': [1], 'unexpected': 1}]]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                ui.invoke(values, '.')

    def test_http_group_contract(self):
        ui = tk.Interface(lambda a, b: a['main'] + b['main'] + a['additional'][0], [
            {'main': tk.Text('A'), 'additional': [tk.Select(choices=['!'])]},
            {'main': tk.Text('B')},
        ], tk.Text())
        server, url = make_server(ui)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(url + 'schema') as response:
                schema = json.load(response)
            self.assertEqual(schema['input_mode'], 'grouped')
            self.assertEqual(schema['inputs'][0]['additional'][0]['kind'], 'select')
            request = urllib.request.Request(url + 'run', data=json.dumps({'inputs': [
                {'main': 'hello', 'additional': ['!']}, {'main': ' world'},
            ]}).encode(), headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)['outputs'], ['hello world!'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
