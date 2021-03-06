#!/usr/bin/env node

'use strict';

var _ = require('lodash'),
    async = require('async'),
    child_process = require('child_process'),
    fs = require('fs'),
    program = require('commander'),
    removeMd = require('remove-markdown'),
    versionRegExp = /^[0-9]+\.[0-9]+(\.[0-9]+(\.[0-9]+)?)?$/;

console.log('MERGELOGGA');

program.version('0.1.2')
    .description('Generate changelog from merge requests in Git history of current repository and prepend it to specified file.')
    .option('-b, --branch [refname]', 'Branch to generate changelog.', '')
    .option('-a, --all', 'Use all commits, not only merge requests.')
    .option('-f, --changelog [file]', 'File to output changelog.', 'CHANGELOG.md')
    .option('-s, --start-version [version]', 'Set this version before processing commits.', versionRegExp, false)
    .option('-o, --overwrite', 'Overwrite changelog instead of prepending.')
    .option('-T, --no-trim', 'Do not trim commit messages to oneline title.')
    .parse(process.argv);

var branch = program.branch,
    allCommits = program.all,
    changelogFile = program.changelog,
    overwriteChangelog = program.overwrite,
    startVersion = program.startVersion,
    shortCommitMessage = program.trim,
    oldChangelogHeader = '',
    oldChangelog = '',
    untilVersion;

console.log('\n' + (branch ? branch : '<current>') + '  --' + (overwriteChangelog ? '-/overwrite/--' : '') + '->  ' + changelogFile + '\n');

async.waterfall([
    readChangelogFile,
    getLastVersionFromChangelog,
    getVersionsWithCommits,
    getMessagesForVersions,
    filterEmptyVersions,
    generateChangelog,
    writeChangelogFile
], handleFinish);

function readChangelogFile(callback) {
    fs.stat(changelogFile, function (error, stat) {
        if (stat) {
            fs.readFile(changelogFile, {encoding: 'utf8'}, function (error, data) {
                if (error) console.log('ERROR: Unable to read changelog file.');
                callback(error, data ? data.toString() : '');
            });
        } else {
            console.log('No changelog file.');
            callback(null, '');
        }
    });
}

function getLastVersionFromChangelog(changelog, callback) {
    if (overwriteChangelog || !changelog) {
        callback(null);
    } else {
        _.forEach(changelog.split(/\r?\n/g), function (line) {
            if (!untilVersion && line.match(versionRegExp)) {
                untilVersion = line;
                console.log('Last version in changelog file is: ' + untilVersion);
            }
            if (untilVersion) {
                oldChangelog += line + '\n';
            } else {
                oldChangelogHeader += line + '\n';
            }
        });
        oldChangelog = oldChangelog.substring(0, oldChangelog.length - 1);
        if (!untilVersion) {
            console.log('No last version found in changelog.');
        }
        callback(null);
    }
}

function getTagVersion(refNamesString) {
    return refNamesString ? _.first(_.filter(_.map(refNamesString.match(/tag\:\s*[^,)\s]+/g) || [], function (t) {
        return (t.match(/^tag\:\s*v?(\d+\.\d+(\.\d+(\.\d+)?)?)/) || [])[1];
    }))) : undefined;
}

function getVersionsWithCommits(callback) {
    var args = ['log', '--pretty=tformat:%h %p#%d'],
        git,
        versionsWithCommits = [],
        currentCommits = [],
        currentVersion = startVersion,
        processKilled = false;

    if (branch) {
        args.push(branch)
    }

    console.log('Extracting versions...');
    if (currentVersion) {
        console.log('Start version: ' + currentVersion);
    }
    git = child_process.spawn('git', args);
    git.stdout.setEncoding('utf8');
    git.stdout.on('data', function (data) {
        if (processKilled) {
            return;
        }
        _.forEach(data.toString().split(/\r?\n/g), function (line) {
            var parts, hashes, version;
            line = _.trim(line);
            parts = line.split('#');
            hashes = parts[0].split(' ');
            version = getTagVersion(parts[1]);
            if (version) {
                if (version === untilVersion) {
                    console.log('\u001b[0K' + 'Reached last version ' + version + ' from changelog file.');
                    processKilled = true;
                    git.kill();
                    return false;
                }
                if (currentVersion) {
                    versionsWithCommits.push({
                        version: currentVersion,
                        commits: currentCommits
                    });
                }
                currentCommits = [];
                currentVersion = version;
                console.log('\u001b[0K' + ' * ' + currentVersion);
            }
            if (hashes[0].length && (allCommits || hashes.length > 2)) {
                process.stdout.write('\u001b[0K' + ' * ' + currentVersion + ' -> ' + hashes[0] + '\u001b[0G');
                currentCommits.push(hashes[0]);
            }
        });

    });

    git.on('close', function (code) {
        process.stdout.write('\u001b[0K\u001b[0G');
        if (code) {
            callback('Unable to get merge commits. Git errored with code #' + code);
        } else {
            if (currentVersion) {
                versionsWithCommits.push({
                    version: currentVersion,
                    commits: currentCommits
                });
            }
            callback(null, versionsWithCommits);
        }
    });
}

function getMessageForCommit(hash, callback) {
    var git = child_process.spawn('git', ['show', '-s', '--pretty=tformat:%s%n%b', hash]),
        message = [],
        isMergeRequest = false,
        foundConflict = false;
    git.stdout.setEncoding('utf8');
    git.stdout.on('data', function (data) {
        var lines = data.toString().split(/\r?\n/g);
        lines = _.reduce(lines, function (filtered, line) {
            line = _.trim(line);

            if (line.match(/^(#\s*)?Conflicts:/i)) {
                foundConflict = true;
            }

            if (foundConflict) {
                return filtered;
            }

            if (line.match(/^Merge (remote-tracking )?branch .*/i)) {
                // do nothing
            } else if (line.match(/^See merge request !.*/i)) {
                isMergeRequest = true;
            } else if (line.length > 0) {
                filtered.push(line);
            }

            return filtered;
        }, []);
        message = message.concat(lines);
    });
    git.on('close', function (code) {
        if (code) {
            callback('Unable to get commit message. Git errored with code #' + code);
        } else {
            callback(
                null,
                (shortCommitMessage && message.length > 0 ? message[0] : message.join('\n')),
                isMergeRequest
            );
        }
    });
}

function getMessagesForListOfCommits(commits, callback) {
    var tasks = [];
    _.forEach(commits, function (hash) {
        tasks.push(function (callback) {
            getMessageForCommit(hash, function (error, message, isMergeRequest) {
                if (message) process.stdout.write('\u001b[0K' + ' * ' + _.trunc((message || '').split(/\r?\n/g)[0], 70) + '\u001b[0G');
                callback(error, (allCommits || isMergeRequest) ? removeMd(message) : '');
            });
        });
    });
    async.parallelLimit(tasks, 4, function (error, results) {
        process.stdout.write('\u001b[0K\u001b[0G');
        callback(error, results);
    });
}

function filterEmptyMessages(messages) {
    return _.filter(messages);
}

function getMessagesForVersions(versionsWithCommits, callback) {
    var tasks = [];
    console.log('Processing commit messages...');
    _.forEach(versionsWithCommits, function (versionWithCommits) {
        tasks.push(function (callback) {
            getMessagesForListOfCommits(versionWithCommits.commits, function (error, messages) {
                console.log(' * ' + versionWithCommits.version);
                callback(error, {
                    version: versionWithCommits.version,
                    messages: filterEmptyMessages(messages)
                });
            });
        });
    });
    async.parallelLimit(tasks, 4, function (error, results) {
        callback(error, results);
    });
}

function filterEmptyVersions(versionsWithMessages, callback) {
    callback(null, _.filter(versionsWithMessages, function (versionWithMessages) {
        return versionWithMessages.messages.length > 0;
    }));
}

function generateVersionChangelog(version, messages) {
    return _.reduce(
        messages,
        function (result, message) {
            result += " * " + message + '\n';
            return result;
        },
        version + '\n' + (new Array(version.length + 1).join('=') + '\n')
    );
}

function generateChangelog(versionsWithMessages, callback) {
    var changelog = '';
    console.log('Generating changelog' + (untilVersion ? ' until version ' + untilVersion : ''));
    _.forEach(versionsWithMessages, function (versionWithMessages) {
        if (versionWithMessages.version === untilVersion) {
            return false;
        }
        changelog += generateVersionChangelog(versionWithMessages.version, versionWithMessages.messages) + '\n';
    });
    callback(null, changelog);
}

function writeChangelogFile(changelog, callback) {
    if (changelog) {
        console.log('\n' + changelog);
        console.log('Writing changelog... ---> ' + changelogFile);
        fs.writeFile(changelogFile, oldChangelogHeader + changelog + oldChangelog, {encoding: 'utf8'}, function (error) {
            callback(error);
        });
    } else {
        console.log('No changelog updates.');
        callback(null);
    }
}

function handleFinish(error) {
    if (error) {
        console.error('ERROR: ' + error);
        process.exit(1);
    } else {
        console.log('Success!');
    }
}
