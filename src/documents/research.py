import hashlib
import base64
import hmac
import json
import os
from urllib.error import HTTPError
from urllib.error import URLError
from urllib.request import Request
from urllib.request import urlopen

from django.http import HttpResponse
from django.contrib.auth.models import User
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from documents.models import Document
from documents.permissions import has_perms_owner_aware
from documents.versioning import get_root_document


def research_key(document):
    identity = f"{os.environ['PAPERLESS_RESEARCH_INSTANCE']}:{get_root_document(document).pk}:{document.pk}:{document.checksum}"
    return hashlib.sha256(identity.encode()).hexdigest()


def permitted_document(user, document_id, change=False):
    document = get_object_or_404(Document, pk=document_id, deleted_at__isnull=True)
    root = get_root_document(document)
    permission = 'documents.change_document' if change else 'documents.view_document'
    if (root.deleted_at is not None or not user.is_active or not user.has_perm(permission)
            or not has_perms_owner_aware(user, permission, root)):
        raise PermissionDenied()
    return document


class ResearchAuthorizeView(APIView):
    permission_classes = []
    authentication_classes = []

    def post(self, request):
        secret = os.environ.get('PAPERLESS_RESEARCH_SECRET', '')
        if not secret or not hmac.compare_digest(request.headers.get('X-Research-Secret', '').encode(), secret.encode()):
            raise PermissionDenied()
        user = get_object_or_404(User, pk=request.data.get('user_id'))
        document = permitted_document(user, request.data.get('document_id'))
        permitted_document(user, document.pk, change=True)
        if research_key(document) != request.data.get('paper_key'):
            raise PermissionDenied()
        return Response({'authorized': True})


class ResearchLibraryView(APIView):
    collection = "library"
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not request.user.is_active or not request.user.has_perm('documents.view_document'):
            raise PermissionDenied()
        try:
            offset = max(0, int(request.query_params.get('offset', '0')))
        except ValueError:
            return Response(status=400)
        base_url = os.environ.get('PAPERLESS_RESEARCH_URL')
        secret = os.environ.get('PAPERLESS_RESEARCH_SECRET')
        if not base_url or not secret:
            return Response({'detail': '研究服务尚未配置。'}, status=503)
        upstream = Request(base_url + f'/{self.collection}?offset={offset}',
                           headers={'X-Research-Secret': secret, 'X-Research-User': str(request.user.pk)})
        try:
            with urlopen(upstream, timeout=20) as result:
                payload = json.loads(result.read(2 * 1024 * 1024))
            visible = []
            for item in payload['results']:
                document = Document.objects.filter(pk=item['document_id'], deleted_at__isnull=True).first()
                if document is None or item['instance'] != os.environ['PAPERLESS_RESEARCH_INSTANCE']:
                    continue
                root = get_root_document(document)
                if (root.deleted_at is None and has_perms_owner_aware(request.user, 'documents.view_document', root)
                        and item['key'] == research_key(document)):
                    visible.append({'document_id': document.pk, 'title': item['metadata'].get('title', document.title),
                                    'list_status': item.get('list_status', 'none'), 'starred': bool(item.get('starred')),
                                    'last_opened': item.get('last_opened', ''), 'reading_days': item.get('reading_days', []),
                                    **({name: item.get(name) for name in ('id','kind','status','stage','attempt','error_detail','created_at','provenance')} if self.collection == 'tasks' else {})})
            response = Response({'results': visible, 'next_offset': payload['next_offset']})
            response['Cache-Control'] = 'private, no-store'
            return response
        except (HTTPError, URLError, TimeoutError):
            return Response({'detail': '研究列表暂不可用。'}, status=503)


class ResearchTasksView(ResearchLibraryView):
    collection = "tasks"


class ResearchSettingsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return self.proxy(request)

    def post(self, request):
        return self.proxy(request)

    def proxy(self, request):
        if not request.user.is_active or not request.user.has_perm('documents.view_document'):
            raise PermissionDenied()
        base_url, secret = os.environ.get('PAPERLESS_RESEARCH_URL'), os.environ.get('PAPERLESS_RESEARCH_SECRET')
        if not base_url or not secret:
            return Response(status=503)
        payload = {name: request.data[name] for name in ('model', 'output_language', 'analysis_template') if name in request.data}
        if len(json.dumps(payload)) > 12000:
            return Response(status=400)
        upstream = Request(base_url + '/settings', data=json.dumps(payload).encode() if request.method == 'POST' else None,
                           headers={'X-Research-Secret': secret, 'X-Research-User': str(request.user.pk), 'Content-Type': 'application/json'}, method=request.method)
        try:
            with urlopen(upstream, timeout=20) as result:
                data = json.loads(result.read(20000))
                data['ai_enabled'] = data.get('ai_enabled', False) and os.environ.get('PAPERLESS_RESEARCH_EXTERNAL_ENABLED') == 'true'
                response = Response(data)
                response['Cache-Control'] = 'private, no-store'
                return response
        except HTTPError as error:
            return Response({'detail': '研究偏好未保存，请检查模型、语言和模板。'}, status=400 if error.code == 400 else 502)
        except (URLError, TimeoutError):
            return Response({'detail': '研究服务暂不可用。'}, status=503)


class ResearchView(APIView):
    permission_classes = [IsAuthenticated]

    def dispatch_research(self, request, document_id, action='', artifact_id=None, task_id=None):
        document = permitted_document(request.user, document_id)
        root = get_root_document(document)
        if root.deleted_at is not None:
            raise PermissionDenied()
        if not request.user.is_active or not request.user.has_perm('documents.view_document'):
            raise PermissionDenied()
        if not has_perms_owner_aware(request.user, 'documents.view_document', root):
            raise PermissionDenied()
        if action in {'artifacts', 'bibliography', 'tasks', 'cancel', 'restore'} and request.method == 'POST':
            if not request.user.has_perm('documents.change_document') or not has_perms_owner_aware(
                request.user, 'documents.change_document', root,
            ):
                raise PermissionDenied()
        base_url = os.environ.get('PAPERLESS_RESEARCH_URL')
        secret = os.environ.get('PAPERLESS_RESEARCH_SECRET')
        if not base_url or not secret:
            return Response({'detail': '研究服务尚未配置。'}, status=503)
        key = research_key(document)
        path = f'/papers/{key}'
        if task_id:
            path += f'/tasks/{task_id}/cancel'
        elif action:
            path += f'/{action}'
        if artifact_id:
            path += f'/{artifact_id}'
        headers = {'X-Research-Secret': secret, 'X-Research-User': str(request.user.pk), 'X-Document-Checksum': document.checksum}
        if action in {'export', 'restore'}:
            checksum = hashlib.sha256()
            with document.source_file as original:
                for chunk in iter(lambda: original.read(1024 * 1024), b''):
                    checksum.update(chunk)
            headers['X-Document-Checksum'] = checksum.hexdigest()
        body = None
        if request.method == 'POST':
            if action in {'artifacts', 'restore'}:
                upload = request.FILES.get('file')
                if upload is None or upload.size > 10 * 1024 * 1024:
                    return Response({'detail': '请选择不超过 10 MiB 的 PDF 或 Markdown。'}, status=400)
                body = upload.read()
                if action == 'restore':
                    from documents.research_annotations import validate_archive_original
                    try:
                        validate_archive_original(document, body)
                    except ValueError:
                        return Response({'detail': '研究包格式或原文批注页面关联无效。'}, status=400)
                headers['X-Artifact-Kind'] = str(request.data.get('kind', ''))
                headers['Content-Type'] = 'application/octet-stream'
            else:
                payload = {'title': document.title, 'document_id': document.pk,
                           'instance': os.environ['PAPERLESS_RESEARCH_INSTANCE']}
                if action in {'personal', 'bibliography', 'reading'}:
                    payload = request.data
                elif action == 'tasks':
                    payload.update({name: request.data.get(name) for name in ('kind', 'force', 'retry_task_id', 'confirm_external')})
                    payload.update({name: request.data[name] for name in ('model', 'output_language', 'analysis_template') if name in request.data})
                    if os.environ.get('PAPERLESS_RESEARCH_EXTERNAL_ENABLED') == 'true' and payload['confirm_external'] is True:
                        if document.mime_type != 'application/pdf':
                            return Response({'detail': '研究任务只接受 PDF。'}, status=400)
                        with document.source_file as source:
                            content = source.read(10 * 1024 * 1024 + 1)
                        if len(content) > 10 * 1024 * 1024:
                            return Response({'detail': '任务输入超过10MiB。'}, status=413)
                        payload['input_pdf'] = base64.b64encode(content).decode()
                        payload['source_sha256'] = hashlib.sha256(content).hexdigest()
                    else:
                        payload['confirm_external'] = False
                body = json.dumps(payload).encode()
                headers['Content-Type'] = 'application/json'
        if artifact_id and request.headers.get('Range'):
            headers['Range'] = request.headers['Range']
        upstream = Request(base_url + path, data=body, headers=headers, method=request.method)
        try:
            with urlopen(upstream, timeout=20) as result:
                content = result.read(12 * 1024 * 1024 + 1)
                if len(content) > 12 * 1024 * 1024:
                    return Response({'detail': '研究产物超过允许大小。'}, status=502)
                if artifact_id or action in {'bibtex', 'export'}:
                    response = HttpResponse(content, status=result.status,
                                            content_type=result.headers.get('Content-Type'))
                    for name in ('Content-Range', 'Accept-Ranges', 'Content-Disposition'):
                        if result.headers.get(name):
                            response[name] = result.headers[name]
                    response['Cache-Control'] = 'private, no-store'
                    response['X-Content-Type-Options'] = 'nosniff'
                    return response
                payload = json.loads(content)
                payload['document_id'] = document.pk
                if 'ai_enabled' in payload:
                    payload['ai_enabled'] = payload['ai_enabled'] and os.environ.get('PAPERLESS_RESEARCH_EXTERNAL_ENABLED') == 'true'
                payload['can_import'] = request.user.has_perm('documents.change_document') and has_perms_owner_aware(
                    request.user, 'documents.change_document', root,
                )
                response = Response(payload, status=result.status)
                response['Cache-Control'] = 'private, no-store'
                return response
        except HTTPError as error:
            if error.code in (400, 409):
                try:
                    detail = json.loads(error.read(2048))
                    return Response({'code': detail.get('code'), 'detail': detail.get('detail', '研究请求未成功。')}, status=error.code)
                except ValueError:
                    pass
            return Response({'detail': '研究服务请求未成功。'}, status=error.code if error.code in (400, 404, 405, 413, 416) else 502)
        except (URLError, TimeoutError):
            return Response({'detail': '研究服务暂不可用，可重试；原始 PDF 仍可阅读。'}, status=503)

    def get(self, request, document_id, action='', artifact_id=None, task_id=None):
        return self.dispatch_research(request, document_id, action, artifact_id)

    def post(self, request, document_id, action='', artifact_id=None, task_id=None):
        if artifact_id:
            return Response(status=405)
        return self.dispatch_research(request, document_id, action, task_id=task_id)
