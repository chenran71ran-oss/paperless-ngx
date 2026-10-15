import shutil
import tempfile
from datetime import date
from pathlib import Path
from unittest import mock

import pytest
from django.test import TestCase
from django.test import override_settings
from faker import Faker

from documents.models import Correspondent
from documents.models import Document
from documents.tasks import empty_trash


class TestDocument(TestCase):
    def setUp(self) -> None:
        self.originals_dir = tempfile.mkdtemp()
        self.thumb_dir = tempfile.mkdtemp()

        self.overrides = override_settings(
            ORIGINALS_DIR=self.originals_dir,
            THUMBNAIL_DIR=self.thumb_dir,
        )

        self.overrides.enable()

    def tearDown(self) -> None:
        shutil.rmtree(self.originals_dir)
        shutil.rmtree(self.thumb_dir)
        self.overrides.disable()

    def test_file_deletion(self) -> None:
        document = Document.objects.create(
            correspondent=Correspondent.objects.create(name="Test0"),
            title="Title",
            content="content",
            checksum="checksum",
            mime_type="application/pdf",
        )

        file_path = document.source_path
        thumb_path = document.thumbnail_path

        Path(file_path).touch()
        Path(thumb_path).touch()

        with mock.patch(
            "documents.signals.handlers.Path.unlink",
            autospec=True,
        ) as mock_unlink:
            document.delete()
            empty_trash([document.pk])

            target_paths: set[str] = {str(file_path), str(thumb_path)}

            actual_deletions = [
                call
                for call in mock_unlink.call_args_list
                if str(call.args[0]) in target_paths
            ]

            self.assertEqual(len(actual_deletions), 2)

    def test_document_soft_delete(self) -> None:
        document = Document.objects.create(
            correspondent=Correspondent.objects.create(name="Test0"),
            title="Title",
            content="content",
            checksum="checksum",
            mime_type="application/pdf",
        )

        file_path = document.source_path
        thumb_path = document.thumbnail_path

        Path(file_path).touch()
        Path(thumb_path).touch()

        target_paths: set[str] = {str(file_path), str(thumb_path)}

        with mock.patch(
            "documents.signals.handlers.Path.unlink",
            autospec=True,
        ) as mock_unlink:
            document.delete()
            self.assertEqual(mock_unlink.call_count, 0)

            self.assertEqual(Document.objects.count(), 0)

            document.restore(strict=False)
            self.assertEqual(Document.objects.count(), 1)

            document.delete()
            empty_trash([document.pk])

            actual_deletions = [
                call
                for call in mock_unlink.call_args_list
                if str(call.args[0]) in target_paths
            ]

            self.assertEqual(len(actual_deletions), 2)

    def test_delete_root_deletes_versions(self) -> None:
        root = Document.objects.create(
            correspondent=Correspondent.objects.create(name="Test0"),
            title="Head",
            content="content",
            checksum="checksum",
            mime_type="application/pdf",
        )
        version = Document.objects.create(
            root_document=root,
            correspondent=root.correspondent,
            title="Version",
            content="content",
            checksum="checksum2",
            mime_type="application/pdf",
        )

        root.delete()

        self.assertEqual(Document.objects.count(), 0)
        self.assertEqual(Document.deleted_objects.count(), 2)

        root.restore(strict=False)

        self.assertTrue(Document.objects.filter(pk=version.pk).exists())

    def test_file_name(self) -> None:
        doc = Document(
            mime_type="application/pdf",
            title="test",
            created=date(2020, 12, 25),
        )
        self.assertEqual(doc.get_public_filename(), "2020-12-25 test.pdf")

    def test_file_name_jpg(self) -> None:
        doc = Document(
            mime_type="image/jpeg",
            title="test",
            created=date(2020, 12, 25),
        )
        self.assertEqual(doc.get_public_filename(), "2020-12-25 test.jpg")

    def test_file_name_unknown(self) -> None:
        doc = Document(
            mime_type="application/zip",
            title="test",
            created=date(2020, 12, 25),
        )
        self.assertEqual(doc.get_public_filename(), "2020-12-25 test.zip")

    def test_file_name_invalid_type(self) -> None:
        doc = Document(
            mime_type="image/jpegasd",
            title="test",
            created=date(2020, 12, 25),
        )
        self.assertEqual(doc.get_public_filename(), "2020-12-25 test")

    def test_version_file_name_uses_root_document_metadata(self) -> None:
        root_correspondent = Correspondent.objects.create(name="Root correspondent")
        version_correspondent = Correspondent.objects.create(
            name="Version correspondent",
        )
        root = Document.objects.create(
            mime_type="application/pdf",
            title="Root title",
            created=date(2020, 12, 25),
            correspondent=root_correspondent,
        )
        version = Document.objects.create(
            mime_type="application/pdf",
            title="Version title",
            created=date(1990, 1, 1),
            correspondent=version_correspondent,
            root_document=root,
            version_index=1,
        )

        self.assertEqual(
            version.get_public_filename(),
            "2020-12-25 Root correspondent Root title.pdf",
        )

        root.title = "Updated root title"
        root.save(update_fields=("title",))
        version.refresh_from_db()

        self.assertEqual(
            version.get_public_filename(),
            "2020-12-25 Root correspondent Updated root title.pdf",
        )

    def test_suggestion_content_uses_latest_version_content_for_root_documents(
        self,
    ) -> None:
        root = Document.objects.create(
            title="root",
            checksum="root",
            mime_type="application/pdf",
            content="outdated root content",
        )
        version = Document.objects.create(
            title="v1",
            checksum="v1",
            mime_type="application/pdf",
            root_document=root,
            content="latest version content",
        )

        self.assertEqual(root.suggestion_content, version.content)

    def test_content_length_is_per_document_row_for_versions(self) -> None:
        root = Document.objects.create(
            title="root",
            checksum="root",
            mime_type="application/pdf",
            content="abc",
        )
        version = Document.objects.create(
            title="v1",
            checksum="v1",
            mime_type="application/pdf",
            root_document=root,
            content="abcdefgh",
        )

        root.refresh_from_db()
        version.refresh_from_db()

        self.assertEqual(root.content_length, 3)
        self.assertEqual(version.content_length, 8)


def test_suggestion_content() -> None:
    """
    Check that the document for suggestion is cropped, only if it exceeds the length limit.
    """
    fake_text = Faker().text(max_nb_chars=1201000)

    # Do not crop content under 1.2M chars
    content_under_limit = fake_text[:1200000]
    doc = Document(
        title="test",
        created=date(2025, 6, 1),
        content=content_under_limit,
    )
    assert doc.suggestion_content == content_under_limit

    # If over the limit, crop to 1M char (800K from the beginning, 200K from the end)
    content_over_limit = fake_text[:1200001]
    expected_cropped_content = (
        content_over_limit[:800000] + " " + content_over_limit[-200000:]
    )
    doc.content = content_over_limit
    assert doc.suggestion_content == expected_cropped_content


@pytest.mark.django_db
class TestPublicFilenameLength:
    @pytest.mark.parametrize(
        ("title", "archive", "extension"),
        [
            pytest.param("a" * 300, False, ".jpg", id="ascii-original"),
            pytest.param("a" * 300, True, ".pdf", id="ascii-archive"),
            pytest.param("ä" * 200, False, ".jpg", id="multibyte-original"),
        ],
    )
    def test_long_title_keeps_extension_within_limit(
        self,
        title: str,
        *,
        archive: bool,
        extension: str,
    ) -> None:
        """
        GIVEN:
            - A document whose title alone is longer than 255 bytes
        WHEN:
            - The public file name is generated
        THEN:
            - The name fits in 255 bytes and still ends with the extension
        """
        doc = Document(mime_type="image/jpeg", title=title, created=date(2020, 12, 25))

        name = doc.get_public_filename(archive=archive)

        assert len(name.encode()) <= 255
        assert name.endswith(extension)

    def test_long_title_counters_give_distinct_names(self) -> None:
        """
        GIVEN:
            - A document whose title alone is longer than 255 bytes
        WHEN:
            - Public file names are generated with increasing counters
        THEN:
            - Each counter produces a distinct name that keeps the counter
        """
        doc = Document(
            mime_type="application/pdf",
            title="ä" * 200,
            created=date(2020, 12, 25),
        )

        names = [doc.get_public_filename(counter=counter) for counter in range(3)]

        assert len(set(names)) == 3
        assert names[1].endswith("_01.pdf")
        assert all(len(name.encode()) <= 255 for name in names)

    def test_max_bytes_bounds_name(self) -> None:
        """
        GIVEN:
            - A document with a long title
        WHEN:
            - The public file name is generated with a smaller byte limit
        THEN:
            - The name fits in that limit and keeps the counter and extension
        """
        doc = Document(
            mime_type="application/pdf",
            title="a" * 300,
            created=date(2020, 12, 25),
        )

        name = doc.get_public_filename(counter=1, max_bytes=100)

        assert len(name.encode()) <= 100
        assert name.endswith("_01.pdf")
