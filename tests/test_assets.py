import threading
import unittest
import urllib.error
import urllib.request
import toolkits as tk
from toolkits.server import make_server


class PackagedInterfaceTests(unittest.TestCase):
    def test_assets_and_token_boundary(self):
        ui = tk.Interface(lambda request: request['main'], [{'main': tk.Text(value='hello')}], tk.Text())
        server, url = make_server(ui)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for name, mime in [('', 'text/html'), ('ui.js', 'text/javascript'), ('ui-content.js', 'text/javascript'), ('ui.css', 'text/css')]:
                with urllib.request.urlopen(url + name) as response:
                    self.assertTrue(response.headers['Content-Type'].startswith(mime))
                    self.assertGreater(len(response.read()), 50)
            for path in ['../ui.js', 'server.py', 'missing/ui.css']:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(url + path)
                self.assertEqual(error.exception.code, 404)
            with urllib.request.urlopen(url) as response:
                self.assertIn("script-src 'self'", response.headers['Content-Security-Policy'])
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_text_defaults_and_public_types(self):
        text = tk.Text('音色', value='longxiaochun_v2')
        self.assertEqual(text.schema()['value'], 'longxiaochun_v2')
        for kwargs in [{'value': None}, {'placeholder': 1}]:
            with self.assertRaises(TypeError): tk.Text(**kwargs)
        self.assertIn('main', tk.InputGroup.__required_keys__)
        self.assertIn('additional', tk.InputGroup.__optional_keys__)
