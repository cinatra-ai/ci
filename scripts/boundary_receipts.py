"""Authenticated append-only verification boundary protocol and its single parser."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

CODE = Path(__file__).resolve().parent
MARKER = '<!-- cinatra-verification-boundary:v1 -->'
SCHEMA = 'cinatra.verification-boundary/v1'
STATES = {'candidate-pending-ci', 'candidate-pending-proof', 'proof-failed', 'preserved-failing', 'candidate', 'promoted', 'not-a-lane'}
API_VERSION = '2022-11-28'
SHA = re.compile(r'[0-9a-f]{40}')
HEX = re.compile(r'[0-9a-f]{64}')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def loads(text):
    return json.loads(text, object_pairs_hook=unique, parse_constant=lambda x: (_ for _ in ()).throw(ValueError('non-finite JSON')))


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def positive(value):
    return type(value) is int and 0 < value <= 9007199254740991


def configured_bot(config):
    # Reuse only the source-owned principal, never the delegated authorization.
    trust = loads((CODE/'delegated-merge-contract.json').read_text())
    bot = trust['bot']
    require(trust['organization'] == config['github']['org'] and bot['login'] == config['github']['bot_login'], 'configured bot differs from source-owned principal')
    require(positive(bot['userId']) and positive(bot['appId']), 'invalid bot identity')
    return dict(login=bot['login'], userId=bot['userId'], appId=bot['appId'], type='Bot')


WS = "[\t\n\x0b\x0c\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
WS_RX = re.compile(WS)
RSTRIP_RX = re.compile(WS + "+$")
TRIM_RX = re.compile("^" + WS + "+|" + WS + "+$")
CTRL_RX = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\ufeff]")
def trim_ws(t): return TRIM_RX.sub("", t)
HEAD_RX = re.compile(r"^Verification boundary:[ \t]*(candidate-pending-ci|candidate-pending-proof|proof-failed|preserved-failing|candidate|promoted)[ \t]+at[ \t]+([0-9a-f]{40})[ \t]*(.*)$", re.I | re.A)
LANE_RX = re.compile(r"^Verification boundary:[ \t]*not-a-lane$", re.I | re.A)
BOTH_RX = re.compile(r"^\(checks:[ \t]*(.*?)\)[ \t]*checks-json:[ \t]*(\[.*\])$", re.I | re.A)   # non-greedy: the legacy half may not swallow the marker
JSON_RX = re.compile(r"^checks-json:[ \t]*(\[.*\])$", re.I | re.A)
OLD_RX  = re.compile(r"^\(checks:[ \t]*(.*)\)$", re.I | re.A)
MARKER_RX = re.compile(r"checks-json:", re.I | re.A)
def _legacy_checks(text):
    """(ok, checks) for the legacy ';'-separated list — balanced parentheses, no nested checks-json marker."""
    if text.count("(") != text.count(")"): return False, None
    if MARKER_RX.search(text): return False, None
    return True, [trim_ws(c) for c in text.split(";") if trim_ws(c)]
def _json_checks(text):
    try: v = json.loads(text)
    except Exception: return False, None
    if not isinstance(v, list): return False, None
    out = []
    for e in v:
        if not isinstance(e, str) or WS_RX.sub("", e) == "" or CTRL_RX.search(e): return False, None
        out.append(e)
    return True, out
def parse_checks(tail):
    """(ok, checks) for whatever follows the sha on a boundary line; ok=False means MALFORMED."""
    tail = trim_ws(tail)
    if not tail: return True, []
    m = BOTH_RX.match(tail)
    if m:
        ok, _ = _legacy_checks(m.group(1))
        if not ok: return False, None      # the legacy half must be well formed even though checks-json decides
        return _json_checks(m.group(2))
    m = JSON_RX.match(tail)
    if m: return _json_checks(m.group(1))
    m = OLD_RX.match(tail)
    if m: return _legacy_checks(m.group(1))
    return False, None


def scan_section(body, seed=''):
    lines = []; fence = None; malformed = []; not_a_lane = False
    prior = seed.replace("\r\n", "\n").replace("\r", "\n").split("\n") if seed else []
    own = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for index, raw in enumerate(prior + own):
        line = raw
        m = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if fence:
            # a CLOSING fence is the fence run alone on its line (only whitespace after it), same char, at least as long
            c = re.match(r"^ {0,3}(`{3,}|~{3,})[ \t]*$", line)
            if c and c.group(1)[0] == fence[0] and len(c.group(1)) >= len(fence): fence = None
            continue
        if m: fence = m.group(1); continue   # an opening fence may carry an info string
        if line.startswith("    ") or line.startswith("\t"): continue          # indented code
        if index < len(prior): continue  # seed affects fences only, not records
        if line.lower().startswith("verification boundary:"):
            if CTRL_RX.search(line): malformed.append(line); continue   # a control/format character ANYWHERE in a record line, trailing included
            rec = RSTRIP_RX.sub("", line)
            if LANE_RX.match(rec): not_a_lane = True; continue
            mm = HEAD_RX.match(rec)
            if not mm: malformed.append(line); continue
            ok, checks = parse_checks(mm.group(3))
            if not ok: malformed.append(line); continue
            lines.append((mm.group(1).lower(), mm.group(2).lower(), checks))
    return lines, malformed, not_a_lane


def section_record(body, head):
    lines, malformed, not_lane = scan_section(body)
    require(not malformed and len(lines) + int(not_lane) == 1, 'exactly one well-formed boundary record required')
    require(SHA.fullmatch(head), 'full head required')
    if not_lane:
        return 'not-a-lane', []
    state, actual, checks = lines[0]
    require(actual == head, 'section head differs from remote head')
    return state, checks


def historical_grammar(value):
    # Explicit offline diagnostics preserve the old state/check grammar only.
    lines, malformed, not_lane = scan_section(value.get('body') or '')
    require(not malformed, 'malformed boundary line')
    if not lines:
        require(not_lane or value.get('user', {}).get('login') != 'groganz-bot[bot]', 'no record')
        return 'no record'
    head = os.environ.get('HEAD') or value.get('head', '')
    if isinstance(head, dict): head = head.get('sha')
    mine = [row for row in lines if row[1] == head]
    require(mine, 'no current-head record')
    state, _, checks = mine[-1]
    if state == 'promoted':
        pending = [row for row in mine[:-1] if row[0] == 'candidate-pending-ci']
        require(pending and not set(pending[-1][2]) - set(checks), 'promotion misses pending checks')
    else:
        require(state == 'candidate', 'noncandidate state')
    return state + ' checks ' + repr(checks)


class GitHub:
    def __call__(self, endpoint, method='GET', payload=None):
        command = ['gh', 'api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: '+API_VERSION, '-X', method, endpoint]
        if payload is not None: command += ['--input', '-']
        result = subprocess.run(command, input=canonical(payload) if payload is not None else None,
                                text=True, capture_output=True, timeout=40)
        require(result.returncode == 0, 'GitHub read/write failed: '+method+' '+endpoint)
        require(len(result.stdout) <= 16 * 1024 * 1024, 'oversized GitHub response')
        return loads(result.stdout)


def comment_body(receipt):
    return MARKER+'\n```json\n'+canonical(receipt)+'\n```\nReceipt-SHA256: '+digest(receipt)+'\n'


def parse_receipt(body):
    require(isinstance(body, str) and len(body) <= 65536, 'bounded comment body required')
    pattern = re.escape(MARKER)+r'\n```json\n([^\n]+)\n```\nReceipt-SHA256: ([0-9a-f]{64})\n'
    match = re.fullmatch(pattern, body)
    require(match, 'malformed boundary receipt')
    value = loads(match[1])
    require(isinstance(value, dict) and set(value) == {'schema','repository','repositoryId','pullRequest','headSha','state','checks','previous'}, 'invalid receipt fields')
    require(value['schema'] == SCHEMA and value['state'] in STATES, 'unsupported boundary receipt')
    require(isinstance(value['repository'], str) and re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', value['repository']), 'invalid repository')
    require(positive(value['repositoryId']) and positive(value['pullRequest']) and isinstance(value['headSha'], str) and SHA.fullmatch(value['headSha']), 'invalid receipt scope')
    checks = value['checks']
    require(isinstance(checks, list) and all(isinstance(x, str) and trim_ws(x) and not CTRL_RX.search(x) for x in checks), 'invalid checklist')
    require(len(checks) == len(set(checks)), 'duplicate checklist entry')
    prev = value['previous']
    require(prev is None or isinstance(prev, dict) and set(prev) == {'commentId','digest'} and positive(prev['commentId']) and isinstance(prev['digest'], str) and HEX.fullmatch(prev['digest']), 'invalid receipt predecessor')
    require(canonical(value) == match[1] and digest(value) == match[2], 'noncanonical receipt or digest mismatch')
    return value


def protocol_comment(value):
    return 'cinatra-verification-boundary' in str(value.get('body', ''))


def principal_hint(value, bot):
    user = value.get('user') or {}
    return user.get('id') == bot['userId'] or user.get('login') == bot['login']


def authenticate(value, bot, repo, pr):
    user = value.get('user') or {}
    require(user.get('id') == bot['userId'] and user.get('login') == bot['login'] and user.get('type') == bot['type'] and (value.get('performed_via_github_app') or {}).get('id') == bot['appId'], 'boundary publisher identity differs')
    require(positive(value.get('id')), 'invalid comment identity')
    require(value.get('issue_url') == 'https://api.github.com/repos/'+repo+'/issues/'+str(pr)
            and value.get('html_url') == 'https://github.com/'+repo+'/pull/'+str(pr)+'#issuecomment-'+str(value['id']), 'comment belongs to another pull request')
    created = value.get('created_at')
    require(isinstance(created, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', created) and created == value.get('updated_at'), 'edited or undated boundary comment')


def pull_scope(pull, repo, pr, head, repository):
    require(repository.get('full_name') == repo and positive(repository.get('id')), 'repository identity unreadable')
    require(pull.get('number') == pr and pull.get('state') == 'open' and pull.get('head', {}).get('sha') == head and pull.get('base', {}).get('repo', {}).get('id') == repository['id'] and pull['base']['repo'].get('full_name') == repo, 'pull request identity/head changed')
    require(type(pull.get('comments')) is int and pull['comments'] >= 0, 'comment count unreadable')


def comment_parity(listed, direct):
    """Compare every field except the two observed optional API shape differences.

    Work on copies: stable_read must still compare complete, unchanged list
    snapshots. Values present on both endpoints are never normalized away.
    """
    if not isinstance(listed, dict) or not isinstance(direct, dict):
        return False
    left, right = dict(listed), dict(direct)
    if ('pin' in left) != ('pin' in right):
        present = left if 'pin' in left else right
        if present['pin'] is not None:
            return False
        del present['pin']
    left_app, right_app = left.get('performed_via_github_app'), right.get('performed_via_github_app')
    if isinstance(left_app, dict) and isinstance(right_app, dict):
        if ('client_id' in left_app) != ('client_id' in right_app):
            present = left_app if 'client_id' in left_app else right_app
            value = present['client_id']
            if not isinstance(value, str) or not 0 < len(value) <= 256 or not value.strip():
                return False
            left['performed_via_github_app'] = dict(left_app)
            right['performed_via_github_app'] = dict(right_app)
            del (left if 'client_id' in left_app else right)['performed_via_github_app']['client_id']
    return canonical(left) == canonical(right)


def snapshot(api, repo, pr, head, bot):
    root = '/repos/'+repo
    repository = api(root)
    pull = api(root+'/pulls/'+str(pr))
    pull_scope(pull, repo, pr, head, repository)
    comments = []
    for page in range(1, 21):
        batch = api(root+'/issues/'+str(pr)+'/comments?per_page=100&page='+str(page))
        require(isinstance(batch, list) and len(batch) <= 100, 'invalid comment page')
        comments.extend(batch)
        if len(batch) < 100: break
    else:
        raise ValueError('comment pagination incomplete')
    ids = [row.get('id') for row in comments if isinstance(row, dict)]
    require(len(ids) == len(comments) and all(positive(x) for x in ids) and ids == sorted(set(ids)), 'duplicate or unordered comment inventory')
    require(len(comments) == pull['comments'], 'comment inventory truncated or moved')
    relevant = []
    for row in comments:
        if protocol_comment(row):
            direct = api(root+'/issues/comments/'+str(row['id']))
            require(comment_parity(row, direct), 'direct/list comment read differs')
            if principal_hint(row, bot): relevant.append(row)
    end = api(root+'/pulls/'+str(pr))
    pull_scope(end, repo, pr, head, repository)
    require(end['comments'] == pull['comments'], 'comment count moved')
    return {'repositoryId':repository['id'], 'comments':comments, 'relevant':relevant}


def stable_read(api, repo, pr, head, bot):
    first = snapshot(api, repo, pr, head, bot)
    second = snapshot(api, repo, pr, head, bot)
    require(canonical(first) == canonical(second), 'boundary reads moved')
    return first


def chain(snapshot, repo, pr, bot):
    records = []
    previous = None
    timestamp = ''
    for row in snapshot['relevant']:
        authenticate(row, bot, repo, pr)
        receipt = parse_receipt(row['body'])
        require(receipt['repository'] == repo and receipt['repositoryId'] == snapshot['repositoryId'] and receipt['pullRequest'] == pr, 'receipt scope differs')
        require(receipt['previous'] == previous and row['created_at'] >= timestamp, 'boundary chain incomplete or reordered')
        previous = {'commentId':row['id'], 'digest':digest(receipt)}
        timestamp = row['created_at']
        records.append((row, receipt))
    return records


def verdict(records, head):
    require(records, 'no authenticated boundary receipt; fresh verification/reissue required')
    _, last = records[-1]
    require(last['headSha'] == head, 'latest boundary names another head')
    state = last['state']
    if state == 'promoted':
        pending = records[-2][1] if len(records) > 1 else None
        require(pending and pending['headSha'] == head and pending['state'] == 'candidate-pending-ci'
                and not set(pending['checks']) - set(last['checks']), 'promotion misses immediate authenticated pending checks')
    else:
        require(state in {'candidate', 'not-a-lane'}, 'latest boundary is '+state)
    return {'state':state,'headSha':head,'commentId':records[-1][0]['id'],'digest':digest(last)}


def state_path(config, repo, pr):
    root = Path(config['roots']['coord'])/'boundary-publications'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root/(repo.replace('/', '--')+'-'+str(pr)+'.json')


def write_state(file, value):
    fd, temp = tempfile.mkstemp(prefix=file.name+'.', dir=file.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(canonical(value)+'\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temp, file)
        directory = os.open(file.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def read_state(file):
    return loads(file.read_text()) if file.exists() else {'observed':None, 'intent':None}


def observe(file, state, snapshot):
    # Persist the newest principal-attributed event before parsing, even when
    # malformed/edited. Its subsequent deletion must not resurrect a candidate.
    previous = state.get('observed')
    rows = snapshot['relevant']
    actual = {'commentId':rows[-1]['id'], 'digest':hashlib.sha256(str(rows[-1].get('body', '')).encode()).hexdigest()} if rows else None
    if previous:
        require(actual and actual['commentId'] >= previous['commentId'], 'observed boundary was deleted or rolled back')
        if actual['commentId'] == previous['commentId']: require(actual == previous, 'observed boundary changed')
    state['observed'] = actual
    write_state(file, state)


def validate(api, config, repo, pr, head):
    bot = configured_bot(config)
    file = state_path(config, repo, pr)
    with open(str(file)+'.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = read_state(file)
        require(not state.get('intent'), 'boundary publication unresolved; reconcile before merging')
        snapshot = stable_read(api, repo, pr, head, bot)
        observe(file, state, snapshot)
        records = chain(snapshot, repo, pr, bot)
        return verdict(records, head)


def publish(api, config, repo, pr, head, section, leak_check):
    bot = configured_bot(config)
    target_state, checks = section_record(section, head)
    file = state_path(config, repo, pr)
    with open(str(file)+'.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = read_state(file)
        before = stable_read(api, repo, pr, head, bot)
        observe(file, state, before)
        records = chain(before, repo, pr, bot)
        intent = state.get('intent')
        if intent:
            receipt = parse_receipt(intent['body'])
            require(all(receipt[key] == value for key, value in [('repository',repo),('pullRequest',pr),('headSha',head),('state',target_state),('checks',checks)]), 'another boundary publication is unresolved')
            require(records and records[-1][0]['body'] == intent['body'], 'uncertain POST: receipt absent; never repost automatically')
        else:
            if records:
                last = records[-1][1]
                if last['headSha'] == head and last['state'] == target_state and last['checks'] == checks:
                    return {'commentId':records[-1][0]['id'], 'headSha':head, 'state':target_state, 'idempotent':True}
            receipt = {'schema':SCHEMA,'repository':repo,'repositoryId':before['repositoryId'],'pullRequest':pr,'headSha':head,'state':target_state,'checks':checks,'previous':({'commentId':records[-1][0]['id'],'digest':digest(records[-1][1])} if records else None)}
            if target_state == 'promoted':
                verdict(records + [({'id':1}, receipt)], head)
            # Validate exactly the bytes to publish, then leak-check the sanitized envelope.
            body = comment_body(receipt)
            parse_receipt(body)
            leak_check(body)
            state['intent'] = {'body':body, 'headSha':head}
            write_state(file, state)  # durable before the only POST
            try:
                api('/repos/'+repo+'/issues/'+str(pr)+'/comments', 'POST', {'body':body})
            except Exception:
                # The request may have landed; only reads may reconcile it.
                pass
            after = stable_read(api, repo, pr, head, bot)
            observe(file, state, after)
            records = chain(after, repo, pr, bot)
            require(records and records[-1][0]['body'] == body, 'uncertain POST: matching receipt not observed; intent retained')
            require(sum(row['body'] == body for row, _ in records) == 1, 'duplicate publication; intent retained')
        state['intent'] = None
        observe(file, state, after if not intent else before)
        return {'commentId':records[-1][0]['id'], 'headSha':head, 'state':target_state, 'idempotent':bool(intent)}


def prepare_promotion(api, config, repo, pr, head):
    bot = configured_bot(config)
    file = state_path(config, repo, pr)
    with open(str(file)+'.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = read_state(file)
        require(not state.get('intent'), 'boundary publication unresolved')
        snapshot = stable_read(api, repo, pr, head, bot)
        observe(file, state, snapshot)
        records = chain(snapshot, repo, pr, bot)
        require(records and records[-1][1]['headSha'] == head and records[-1][1]['state'] == 'candidate-pending-ci', 'only authenticated current-head pending-CI can be promoted')
        return 'Verification boundary: promoted at '+head+' checks-json: '+canonical(records[-1][1]['checks'])+'\n'


def inspect_outcome(api, config, repo, pr, head):
    """Authenticated outcome only: this never grants merge eligibility."""
    bot = configured_bot(config)
    file = state_path(config, repo, pr)
    with open(str(file)+'.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = read_state(file)
        require(not state.get('intent'), 'boundary publication unresolved')
        snapshot = stable_read(api, repo, pr, head, bot)
        observe(file, state, snapshot)
        records = chain(snapshot, repo, pr, bot)
        require(records and records[-1][1]['headSha'] == head, 'no current-head authenticated outcome')
        row, receipt = records[-1]
        return {'kind':'authenticated-boundary-outcome','state':receipt['state'],
                'headSha':head,'commentId':row['id'],'digest':digest(receipt)}
