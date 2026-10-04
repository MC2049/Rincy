import os

# 1. 更新 config.js - 添加 exportAgents 和 importAgents 函数
config_path = '/sdcard/ws/Rincy/src/config.js'
with open(config_path, 'r', encoding='utf8') as f:
    config_content = f.read()

# 1.1 添加 exportAgents 函数（如果不存在）
if 'def exportAgents' not in config_content:
    # 找到 module.exports 行并插入函数
    lines = config_content.split('\n')
    # 找到 module.exports 所在的行
    export_lines = []
    for i, line in enumerate(lines):
        if line.strip() == 'module.exports = {':
            break
        export_lines.append(line)
    # 找到 module.exports 行的位置
    module_exports_line = None
    for i, line in enumerate(lines):
        if 'module.exports = {' in line:
            module_exports_line = i
            break
    
    # 确保 exportAgents 在 module.exports 之前
    export_lines.insert(0, 'function exportAgents() {')
    export_lines.append('  const tar = require(\'tar\');')
    export_lines.append('  const fs = require(\'fs\');')
    export_lines.append('  const path = require(\'path\');')
    export_lines.append('  const DATA_DIR = path.join(__dirname, \'..\', \'..\', \'data\')')
    export_lines.append('  const AGENTS_DIR = path.join(DATA_DIR, \'..\', \'..\', \'data\', \'agents\')')
    export_lines.append('  const tempDir = path.join(DATA_DIR, \'.tmp_export_' + str(Date.now()) + '\')')
    export_lines.append('  fs.mkdirSync(tempDir, { recursive: true });')
    export_lines.append('  const agentsTempDir = path.join(tempDir, \'agents\')')
    export_lines.append('  fs.mkdirSync(agentsTempDir, { recursive: true });')
    export_lines.append('  if (fs.existsSync(agentsDir)) {')
    export_lines.append('    fs.cpSync(agentsDir, copyDir, { recursive: true });')
    export_lines.append('  }')
    export_lines.append('  const tarFile = path.join(tempDir, \'agents.tar\')')
    export_lines.append('  const output = fs.createWriteStream(tarFile)')
    export_lines.append('  const archive = tar.c({ cwd: tempDir, portable: true }, [\'agents\'])')
    export_lines.append('  archive.pipe(output)')
    export_lines.append('  archive.on(\'end\', () => {')
    export_lines.append('    fs.rmSync(tempDir, { recursive: true, force: true });')
    export_lines.append('    resolve(Buffer.concat(chunks))')
    export_lines.append('  }).on(\'error\', (err) => {')
    export_lines.append('    fs.rmSync(tempDir, { recursive: true, force: true });')
    export_lines.append('    reject(err)')
    export_lines.append('  });')
    export_lines.append('  const chunks = []')
    export_lines.append('  tar.c({ cwd: tempDir, portable: true }, [\'agents\']).on(\'data\', (chunk) => chunks.push(chunk))')
    export_lines.append('  archive.on(\'end\', () => {')
    export_lines.append('    fs.rmSync(tempDir, { recursive: true, force: true });')
    export_lines.append('    resolve(Buffer.concat(chunks))')
    export_lines.append('  }).on(\'error\', (err) => {')
    export_lines.append('    fs.rmSync(tempDir, { recursive: true, force: true });')
    export_lines.append('    reject(err)')
    export_lines.append('  });')
    
    # 修正：在 exportAgents 之前插入 importAgents 函数
    insert_point = None
    for i in range(len(lines)):
        if 'def importAgents' in lines[i]:
            export_lines.insert(i, '  # 从 tar 导入智能体\n')
            import_lines = [
                'def importAgents(tarBuffer) {',
                '  const tar = require(\'tar\');',
                '  const fs = require(\'fs\');',
                '  const path = require(\'path\');',
                '  const tempDir = path.join(DATA_DIR, \'.tmp_import_' + str(Date.now()) + '\')',
                '  fs.mkdirSync(tempDir, { recursive: true })',
                '  const tarFile = path.join(tempDir, \'upload.tar\')',
                '  fs.writeFileSync(tarFile, tarBuffer)',
                '  tar.x({ cwd: tempDir }, tarBuffer).on(\'end\', () => {',
                '    const importedDir = path.join(tempDir, \'agents\')',
                '    fs.mkdirSync(agentsDir, { recursive: true })',
                '    entries = fs.readdirSync(importedDir)',
                '    for entry in entries:',
                '        src = path.join(importedDir, entry)',
                '        dst = path.join(agentsDir, entry)',
                '        fs.cpSync(src, dst, { recursive: true, force: true })',
                '        count += 1',
                '    }',
                '    fs.rmSync(tempDir, { recursive: true, force: true })',
                '    resolve({ imported: count })',
                '  }).on(\'error\', (err) => {',
                '    fs.rmSync(tempDir, { recursive: true, force: true });',
                '    reject(err)',
                '  });',
                '  tar.x({ cwd: tempDir }, tarBuffer).on(\'end\', () => {',
                '    fs.rmSync(tempDir, { recursive: true, force: true });',
                '  });',
                '};',
                ''
            )
            break
    
    # 重新组合
    new_lines = export_lines + import_lines
    with open(config_path, 'w', encoding='utf8') as f:
        f.write('\n'.join(new_lines))
    
    # 更新 exports
    module_exports_line = None
    for i, line in enumerate(lines):
        if 'module.exports = {' in line:
            module_exports_line = i
            break
    
    if module_exports_line is not None:
        # 确保 exportAgents 和 importAgents 在 exports 中
        exports_line = None
        for i in range(module_exports_line, -1, -1):
            if 'addModel' in lines[i] or 'deleteModel' in lines[i]:
                exports_line = i
                break
        if exports_line is not None:
            # 确保 exportAgents 和 importAgents 在 exports 中
            if 'exportAgents' not in s:
                s = s.replace('module.exports = {', 'module.exports = {')
                s = s.replace('deleteModel, getAgentModel,', 'deleteModel, updateModel, exportAgents, importAgents,')
                print("已更新 exports 列表")
    else:
        # 如果没有 exportAgents 函数，则需要重新构建整个 exports 部分
        print("需要重建 exports 部分")
        # 这将是复杂的重构，但根据上下文，我们假设之前的修改已经处理了 exports 部分
        
print("config.js 更新完成")
