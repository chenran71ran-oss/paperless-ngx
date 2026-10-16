"""Private, version-bound annotations behind Paperless object permissions."""
import hashlib
import io
import json
import os
import re
import zipfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.http import HttpResponse
import pikepdf
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from documents.research import permitted_document, research_key


def validate_archive_original(document, content):
    """Validate original geometry before forwarding a research ZIP merge."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            if len(archive.infolist()) > 100 or sum(entry.file_size for entry in archive.infolist()) > 20 * 1024 * 1024:
                raise ValueError('archive size')
            manifest = json.loads(archive.read('manifest.json'))
        annotations = manifest.get('annotations')
        if annotations is None:
            return
        with document.source_file as original, pikepdf.open(original) as pdf:
            pages = [{'width': float(p.cropbox[2] - p.cropbox[0]), 'height': float(p.cropbox[3] - p.cropbox[1])} for p in pdf.pages]
        for version in annotations['versions']:
            if version['kind'] == 'original' and version['pages'] != pages:
                raise ValueError('original PDF geometry mismatch')
    except (KeyError, TypeError, AttributeError, RuntimeError, RecursionError, zipfile.BadZipFile, pikepdf.PdfError) as error:
        raise ValueError('invalid annotation archive') from error


class ResearchAnnotationsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, document_id):
        return self.dispatch_annotations(request, document_id)

    def post(self, request, document_id):
        return self.dispatch_annotations(request, document_id)

    def dispatch_annotations(self, request, document_id):
        document = permitted_document(request.user, document_id)
        base, secret = os.environ.get('PAPERLESS_RESEARCH_URL'), os.environ.get('PAPERLESS_RESEARCH_SECRET')
        if not base or not secret:
            return Response({'detail': '研究服务尚未配置。'}, status=503)
        key = research_key(document)
        headers = {'X-Research-Secret': secret, 'X-Research-User': str(request.user.pk), 'Content-Type': 'application/json'}

        def upstream(path, payload=None):
            query = Request(base + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
            with urlopen(query, timeout=30) as result:
                content = result.read(12 * 1024 * 1024 + 1)
                if len(content) > 12 * 1024 * 1024:
                    raise ValueError('size')
                return content

        try:
            selector = request.query_params.get('version', 'original')
            state = json.loads(upstream(f'/papers/{key}', {'title': document.title, 'document_id': document.pk,
                                                         'instance': os.environ['PAPERLESS_RESEARCH_INSTANCE']}))
            if selector == 'original':
                if document.mime_type != 'application/pdf':
                    return Response({'detail': '当前原件不是PDF。'}, status=400)
                with document.source_file as source:
                    content = source.read(12 * 1024 * 1024 + 1)
                kind = 'original'
            elif re.fullmatch('[a-f0-9]{32}', selector):
                artifact = next((a for a in state['artifacts'] if a['id'] == selector), None)
                if not artifact or artifact['kind'] not in {'reference_pdf', 'translated_pdf', 'chinese_pdf'}:
                    return Response(status=404)
                content = upstream(f'/papers/{key}/artifacts/{selector}')
                kind = artifact['kind']
            else:
                return Response(status=400)
            if len(content) > 12 * 1024 * 1024:
                return Response(status=413)
            checksum = hashlib.sha256(content).hexdigest()
            with pikepdf.open(io.BytesIO(content)) as pdf:
                pages = [{'width': float(p.cropbox[2] - p.cropbox[0]), 'height': float(p.cropbox[3] - p.cropbox[1])} for p in pdf.pages]
            version = {'id': 'original:' + checksum if selector == 'original' else selector,
                       'sha256': checksum, 'kind': kind,
                       'pages': pages}
            action = request.query_params.get('download', 'list') if request.method == 'GET' else request.data.get('action')
            if request.method == 'GET' and action not in {'list', 'summary', 'export'}:
                return Response(status=400)
            if request.method == 'POST' and action not in {'create', 'update', 'delete', 'import', 'export_copy', 'discard_draft'}:
                return Response(status=400)
            payload = {'version': version}
            if action == 'export_copy':
                upload = request.FILES.get('file')
                if upload is None or upload.size > 16 * 1024 * 1024:
                    return Response(status=413)
                payload['revisions'] = json.loads(request.data.get('revisions', '{}'))
                approved = json.loads(upstream(f'/papers/{key}/annotations/check-export', payload))
                records = {a['id']: a for a in approved['annotations']}
                copy = upload.read()
                with pikepdf.open(io.BytesIO(copy)) as exported:
                    if len(exported.pages) != len(pages):
                        return Response({'detail': '导出PDF页数与基础文件不一致。'}, status=400)
                    seen = set()
                    for number, page in enumerate(exported.pages, 1):
                        for mark in page.obj.get('/Annots', []):
                            identifier = str(mark.get('/NM', ''))
                            if identifier in records:
                                if identifier in seen or records[identifier]['page'] != number:
                                    return Response({'detail': '导出批注重复或页码不一致。'}, status=400)
                                seen.add(identifier)
                                # PDFium v2 loses non-ASCII comments; encode canonical server text as a PDF string.
                                mark['/Contents'] = pikepdf.String(records[identifier]['comment'])
                    if seen != records.keys():
                        return Response({'detail': '导出副本缺少已保存的批注。'}, status=400)
                    output = io.BytesIO()
                    exported.save(output)
                    copy = output.getvalue()
                permitted_document(request.user, document_id)
                response = HttpResponse(copy, content_type='application/pdf')
                response['Content-Disposition'] = 'attachment; filename="annotated-copy.pdf"'
            else:
                if request.method == 'POST':
                    payload.update({k: request.data[k] for k in ('op_id', 'base_revision', 'annotation', 'data') if k in request.data})
                    payload['action'] = action
                content = upstream(f'/papers/{key}/annotations/' + ('mutate' if action in {'create', 'update', 'delete'} else action), payload)
                permitted_document(request.user, document_id)
                if action == 'summary':
                    response = HttpResponse(content, content_type='text/markdown; charset=utf-8')
                    response['Content-Disposition'] = 'attachment; filename="annotations.md"'
                else:
                    response = Response(json.loads(content))
                    if action == 'export':
                        response['Content-Disposition'] = 'attachment; filename="annotations.json"'
            response['Cache-Control'] = 'private, no-store'
            response['X-Content-Type-Options'] = 'nosniff'
            return response
        except HTTPError as error:
            try:
                detail = json.loads(error.read(16000))
            except (ValueError, UnicodeDecodeError):
                detail = {'detail': '批注服务请求失败。'}
            return Response(detail, status=error.code if error.code in {400, 403, 404, 409, 413} else 502)
        except (URLError, TimeoutError):
            return Response({'detail': '批注服务暂不可用；原文仍可阅读。'}, status=503)
        except (ValueError, TypeError, KeyError, pikepdf.PdfError):
            return Response({'detail': '批注请求或PDF格式无效。'}, status=400)
