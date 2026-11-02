'use strict';
const readline = require('node:readline');
const { color, log } = require('./util');

/**
 * 交互式多选。
 * - 支持方向键上下移动、空格切换、a 全选、回车确认、q/esc 取消。
 * - 非 TTY（管道、CI）时直接返回预选项，绝不阻塞等待输入。
 */
async function multiSelect(question, choices, options = {}) {
  const { preselected = choices.map((_, index) => index), allowEmpty = false } = options;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return preselected.slice();
  return interactiveSelect(question, choices, preselected, allowEmpty);
}

function interactiveSelect(question, choices, preselected, allowEmpty) {
  return new Promise((resolve) => {
    const selected = new Set(preselected);
    let cursor = 0;
    const output = process.stdout;
    const render = (first) => {
      if (!first) output.write(`\u001b[${choices.length + 1}A`);
      output.write('\r\u001b[2K' + question + '\n');
      choices.forEach((choice, index) => {
        const pointer = index === cursor ? color.cyan('❯') : ' ';
        const box = selected.has(index) ? color.green('◉') : '◯';
        const label = index === cursor ? color.bold(choice.label) : choice.label;
        const hint = choice.hint ? color.dim(` — ${choice.hint}`) : '';
        output.write(`\r\u001b[2K${pointer} ${box} ${label}${hint}\n`);
      });
    };
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    render(true);
    const done = (result) => {
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKey);
      output.write('\n');
      resolve(result);
    };
    const onKey = (chunk, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') { cursor = (cursor - 1 + choices.length) % choices.length; render(false); return; }
      if (key.name === 'down' || key.name === 'j') { cursor = (cursor + 1) % choices.length; render(false); return; }
      if (key.name === 'space') {
        if (selected.has(cursor)) selected.delete(cursor); else selected.add(cursor);
        render(false); return;
      }
      if (key.name === 'a' && key.ctrl) { choices.forEach((_, index) => selected.add(index)); render(false); return; }
      if (key.name === 'return' || key.name === 'enter') {
        if (selected.size === 0 && !allowEmpty) { render(false); return; }
        done([...selected].sort((a, b) => a - b)); return;
      }
      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) done(null);
    };
    process.stdin.on('keypress', onKey);
  });
}

async function confirm(question, fallback = false) {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `, (answer) => {
      rl.close();
      const value = (answer || '').trim().toLowerCase();
      if (!value) return resolve(fallback);
      resolve(value === 'y' || value === 'yes');
    });
  });
}

async function selectOne(question, choices, defaultIndex = 0) {
  if (!process.stdin.isTTY) {
    console.log(`${question}（默认 ${choices[defaultIndex].label}）`);
    return choices[defaultIndex];
  }
  const picked = await multiSelect(question, choices, [defaultIndex], false);
  return choices[picked[0]];
}

module.exports = { multiSelect, confirm, selectOne };
