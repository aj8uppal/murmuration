"""Static server that refuses to cache.

The default http.server lets the browser hold on to ES modules and fetched
shaders. A query string on index.html does not bust either of them, so an edit
can appear to do nothing - or worse, a fresh shader can pair with stale JS and
render a black screen at a healthy frame rate. Nothing here is cached.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8173
    root = sys.argv[2] if len(sys.argv) > 2 else '.'
    print(f'→ http://localhost:{port}  (no-store)')
    ThreadingHTTPServer(('127.0.0.1', port), partial(NoCache, directory=root)).serve_forever()
