#!/usr/bin/env python3
"""Read an authenticated current boundary; no coordinator state or publication."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True
import boundary_receipts as boundary


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--pr', required=True, type=int)
    parser.add_argument('--head', required=True)
    args = parser.parse_args()
    trust = boundary.loads((Path(__file__).resolve().parents[1]/'config/delegated-merge-authorities.json').read_text())
    bot = trust['bot']
    boundary.require(trust['schema'] == 'cinatra.delegated-merge-trust/v1'
                     and isinstance(trust['organization'], str)
                     and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*', trust['organization'])
                     and all(boundary.positive(bot[key]) for key in ('userId', 'appId', 'organizationId'))
                     and isinstance(bot['login'], str) and bot['login'].endswith('[bot]'), 'invalid engine principal')
    boundary.require(re.fullmatch(re.escape(trust['organization'])+r'/[A-Za-z0-9][A-Za-z0-9_.-]*', args.repo)
                     and '..' not in args.repo, 'repository outside engine organization')
    boundary.require(boundary.positive(args.pr) and boundary.SHA.fullmatch(args.head), 'exact PR and full head required')
    principal = {key: bot[key] for key in ('login', 'userId', 'appId')}
    principal['type'] = 'Bot'
    root = '/repos/'+args.repo
    pull = root+'/pulls/'+str(args.pr)
    comments = root+'/issues/'+str(args.pr)+'/comments?per_page=100&page='

    def get(endpoint):
        allowed = endpoint in (root, pull)
        allowed = allowed or endpoint in {comments+str(page) for page in range(1, 21)}
        allowed = allowed or re.fullmatch(re.escape(root)+r'/issues/comments/[1-9][0-9]*', endpoint)
        boundary.require(allowed, 'endpoint outside read-only boundary scope')
        env = {**os.environ, 'GH_HOST': 'github.com'}
        env.pop('GH_DEBUG', None)
        result = subprocess.run(['gh', 'api', '--hostname', 'github.com', '-H',
                                 'X-GitHub-Api-Version: '+boundary.API_VERSION, '-X', 'GET', endpoint],
                                text=True, capture_output=True, timeout=40, env=env)
        boundary.require(result.returncode == 0, 'GitHub boundary GET failed')
        boundary.require(len(result.stdout) <= 16*1024*1024, 'oversized GitHub response')
        value = boundary.loads(result.stdout)
        if endpoint == root:
            boundary.require(value.get('owner', {}).get('id') == bot['organizationId']
                             and value['owner'].get('type') == 'Organization', 'repository organization differs')
        return value

    snapshot = boundary.stable_read(get, args.repo, args.pr, args.head, principal)
    result = boundary.verdict(boundary.chain(snapshot, args.repo, args.pr, principal), args.head)
    boundary.require(result['state'] in {'candidate', 'promoted'}, 'boundary is not queue eligible')
    print(boundary.canonical({'schema': 'cinatra.verification-boundary-current/v1',
                              'repository': args.repo, 'repositoryId': snapshot['repositoryId'],
                              'pullRequest': args.pr, **result}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, AttributeError, OSError, subprocess.SubprocessError) as error:
        print('verification-boundary: refused: '+str(error), file=sys.stderr)
        sys.exit(1)
