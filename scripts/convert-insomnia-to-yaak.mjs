#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_INPUT = 'insomnia-workspace-valorant.json';
const DEFAULT_OUTPUT = 'yaak-workspace-valorant.json';

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function convertId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Invalid resource id: ${String(id)}`);
  }
  return id.startsWith('GENERATE_ID::') ? id : `GENERATE_ID::${id}`;
}

function toIsoNoZulu(value) {
  if (value == null) return undefined;

  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? undefined : date.toISOString().replace('Z', '');
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? undefined : date.toISOString().replace('Z', '');
  }

  return undefined;
}

function mapKeyValueItems(items) {
  return (items ?? [])
    .map((item) => ({
      enabled: !item?.disabled,
      name: item?.name ?? '',
      value: item?.value ?? '',
    }))
    .filter(({ name, value }) => name !== '' || value !== '');
}

function mapKeyValueWithFiles(items) {
  return (items ?? []).map((item) => ({
    enabled: !item?.disabled,
    name: item?.name ?? '',
    value: item?.value ?? '',
    file: item?.fileName ?? null,
  }));
}

function mapAuthentication(authentication) {
  let authenticationType = null;
  let mapped = {};

  if (authentication?.type === 'bearer') {
    authenticationType = 'bearer';
    mapped = {
      token: authentication.token ?? '',
    };
  } else if (authentication?.type === 'basic') {
    authenticationType = 'basic';
    mapped = {
      username: authentication.username ?? '',
      password: authentication.password ?? '',
    };
  }

  return { authenticationType, authentication: mapped };
}

function mapBody(body) {
  const mime = body?.mimeType;

  if (mime === 'application/octet-stream') {
    return {
      bodyType: 'binary',
      body: { filePath: body?.fileName ?? '' },
    };
  }

  if (mime === 'application/x-www-form-urlencoded') {
    return {
      bodyType: 'application/x-www-form-urlencoded',
      body: {
        form: mapKeyValueItems(body?.params),
      },
    };
  }

  if (mime === 'multipart/form-data') {
    return {
      bodyType: 'multipart/form-data',
      body: {
        form: mapKeyValueWithFiles(body?.params),
      },
    };
  }

  if (mime === 'application/graphql') {
    return {
      bodyType: 'graphql',
      body: { text: body?.text ?? '' },
    };
  }

  if (mime === 'application/json') {
    return {
      bodyType: 'application/json',
      body: { text: body?.text ?? '' },
    };
  }

  return {
    bodyType: null,
    body: {},
  };
}

function convertTemplateSyntax(value) {
  if (typeof value === 'string') {
    let out = value;

    // Insomnia env vars: {{ var }} -> ${[ var ]}
    out = out.replaceAll(/{{\s*(_\.)?([^}]+?)\s*}}/g, (_match, _legacyPrefix, expr) => {
      return '${[ ' + String(expr).trim() + ' ]}';
    });

    // Insomnia plugin tags: {% valorant_token %} -> ${[ valorant_token() ]}
    out = out.replaceAll(/{%\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*%}/g, (_match, fnName) => {
      return '${[ ' + fnName + '() ]}';
    });

    return out;
  }

  if (Array.isArray(value)) {
    return value.map(convertTemplateSyntax);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, convertTemplateSyntax(v)]),
    );
  }

  return value;
}

function findWorkspaceId(resource, byId) {
  let current = resource;

  while (current) {
    if (current._type === 'workspace') {
      return current._id;
    }

    if (!current.parentId) {
      return null;
    }

    current = byId.get(current.parentId) ?? null;
  }

  return null;
}

function convertInsomniaV4(parsed) {
  if (!Array.isArray(parsed.resources)) {
    throw new Error('Insomnia export is missing resources array');
  }

  const byId = new Map(parsed.resources.filter((r) => r?._id).map((r) => [r._id, r]));
  const childrenByParent = new Map();
  const websocketPayloadByRequestId = new Map();

  for (const resource of parsed.resources) {
    if (resource?._type === 'websocket_payload' && typeof resource.parentId === 'string') {
      const payloads = websocketPayloadByRequestId.get(resource.parentId) ?? [];
      payloads.push(resource);
      websocketPayloadByRequestId.set(resource.parentId, payloads);
      continue;
    }

    if (typeof resource?.parentId === 'string') {
      const children = childrenByParent.get(resource.parentId) ?? [];
      children.push(resource);
      childrenByParent.set(resource.parentId, children);
    }
  }

  const resources = {
    workspaces: [],
    environments: [],
    folders: [],
    httpRequests: [],
    grpcRequests: [],
    websocketRequests: [],
  };

  const workspaces = parsed.resources.filter((r) => isPlainObject(r) && r._type === 'workspace');

  for (const workspace of workspaces) {
    const workspaceOriginalId = workspace._id;
    const workspaceId = convertId(workspaceOriginalId);

    resources.workspaces.push({
      id: workspaceId,
      model: 'workspace',
      name: workspace.name ?? 'Imported Workspace',
      description: workspace.description || undefined,
      createdAt: toIsoNoZulu(workspace.created),
      updatedAt: toIsoNoZulu(workspace.modified),
    });

    const workspaceEnvironments = parsed.resources.filter(
      (r) => isPlainObject(r) && r._type === 'environment' && findWorkspaceId(r, byId) === workspaceOriginalId,
    );

    for (const env of workspaceEnvironments) {
      const isWorkspaceParent = env.parentId === workspaceOriginalId;

      resources.environments.push({
        id: convertId(env._id),
        model: 'environment',
        workspaceId,
        name: env.name ?? 'Environment',
        public: !env.isPrivate,
        parentModel: isWorkspaceParent ? 'workspace' : 'environment',
        parentId: isWorkspaceParent ? null : (env.parentId ? convertId(env.parentId) : null),
        variables: Object.entries(env.data ?? {}).map(([name, val]) => ({
          enabled: true,
          name,
          value: String(val),
        })),
        sortPriority: env.metaSortKey,
        createdAt: toIsoNoZulu(env.created),
        updatedAt: toIsoNoZulu(env.modified),
      });
    }

    const walkChildren = (parentId) => {
      const children = childrenByParent.get(parentId) ?? [];

      for (const child of children) {
        if (!isPlainObject(child)) continue;

        if (child._type === 'request_group') {
          resources.folders.push({
            id: convertId(child._id),
            model: 'folder',
            workspaceId,
            folderId: child.parentId === workspaceOriginalId ? null : convertId(child.parentId),
            name: child.name ?? 'Folder',
            description: child.description || undefined,
            sortPriority: child.metaSortKey,
            createdAt: toIsoNoZulu(child.created),
            updatedAt: toIsoNoZulu(child.modified),
          });

          walkChildren(child._id);
          continue;
        }

        if (child._type === 'request') {
          const { bodyType, body } = mapBody(child.body);
          const auth = mapAuthentication(child.authentication);

          resources.httpRequests.push({
            id: convertId(child.meta?.id ?? child._id),
            model: 'http_request',
            workspaceId,
            folderId: child.parentId === workspaceOriginalId ? null : convertId(child.parentId),
            name: child.name ?? 'Request',
            description: child.description || undefined,
            method: child.method ?? 'GET',
            url: child.url ?? '',
            headers: mapKeyValueItems(child.headers),
            urlParameters: mapKeyValueItems(child.parameters),
            bodyType,
            body,
            ...auth,
            sortPriority: child.metaSortKey,
            createdAt: toIsoNoZulu(child.created),
            updatedAt: toIsoNoZulu(child.modified),
          });

          continue;
        }

        if (child._type === 'websocket_request') {
          const auth = mapAuthentication(child.authentication);
          const firstPayload = websocketPayloadByRequestId.get(child._id)?.[0];

          resources.websocketRequests.push({
            id: convertId(child.meta?.id ?? child._id),
            model: 'websocket_request',
            workspaceId,
            folderId: child.parentId === workspaceOriginalId ? null : convertId(child.parentId),
            name: child.name ?? 'WebSocket Request',
            description: child.description || undefined,
            url: child.url ?? '',
            headers: mapKeyValueItems(child.headers),
            urlParameters: mapKeyValueItems(child.parameters),
            message: firstPayload?.value ?? child?.body?.text ?? '',
            ...auth,
            sortPriority: child.metaSortKey,
            createdAt: toIsoNoZulu(child.created),
            updatedAt: toIsoNoZulu(child.modified),
          });

          continue;
        }

        if (child._type === 'grpc_request') {
          const parts = String(child.protoMethodName ?? '').split('/').filter(Boolean);
          const service = parts[0] ?? null;
          const method = parts[1] ?? null;

          resources.grpcRequests.push({
            id: convertId(child.meta?.id ?? child._id),
            model: 'grpc_request',
            workspaceId,
            folderId: child.parentId === workspaceOriginalId ? null : convertId(child.parentId),
            name: child.name ?? 'gRPC Request',
            description: child.description || undefined,
            url: child.url ?? '',
            service,
            method,
            message: child?.body?.text ?? '',
            metadata: mapKeyValueItems(child.metadata),
            sortPriority: child.metaSortKey,
            createdAt: toIsoNoZulu(child.created),
            updatedAt: toIsoNoZulu(child.modified),
          });
        }
      }
    };

    walkChildren(workspaceOriginalId);
  }

  return {
    yaakSchema: 5,
    resources: convertTemplateSyntax(resources),
  };
}

function main() {
  const inputArg = process.argv[2] ?? DEFAULT_INPUT;
  const outputArg = process.argv[3] ?? DEFAULT_OUTPUT;

  const inputPath = path.resolve(process.cwd(), inputArg);
  const outputPath = path.resolve(process.cwd(), outputArg);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${inputPath}: ${String(err)}`);
  }

  if (!isPlainObject(parsed) || parsed._type !== 'export' || parsed.__export_format !== 4) {
    throw new Error('Only Insomnia export format 4 JSON is supported by this converter script');
  }

  const converted = convertInsomniaV4(parsed);

  fs.writeFileSync(outputPath, JSON.stringify(converted, null, 2) + '\n', 'utf8');

  console.log(`Converted ${inputPath}`);
  console.log(`Wrote ${outputPath}`);
}

main();
