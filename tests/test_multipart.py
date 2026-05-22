from __future__ import annotations

import unittest

from equalify_iris.multipart import parse_multipart


class MultipartTests(unittest.TestCase):
    def test_parse_repeated_image_parts_in_order(self) -> None:
        boundary = "iris"
        body = (
            b"--iris\r\n"
            b'Content-Disposition: form-data; name="images"; filename="page-001.png"\r\n'
            b"Content-Type: image/png\r\n\r\n"
            b"one\r\n"
            b"--iris\r\n"
            b'Content-Disposition: form-data; name="images"; filename="page-002.png"\r\n'
            b"Content-Type: image/png\r\n\r\n"
            b"two\r\n"
            b"--iris--\r\n"
        )

        parts = parse_multipart(f"multipart/form-data; boundary={boundary}", body)

        self.assertEqual([part.filename for part in parts], ["page-001.png", "page-002.png"])
        self.assertEqual([part.data for part in parts], [b"one", b"two"])


if __name__ == "__main__":
    unittest.main()
