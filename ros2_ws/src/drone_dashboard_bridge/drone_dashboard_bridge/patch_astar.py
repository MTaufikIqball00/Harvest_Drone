import re
with open('dashboard_bridge_node.py', 'r') as f:
    content = f.read()

old_block = '''                is_nxt_blocked = blocked(nxt)
                if nxt != goal_c and nxt != start_c and is_nxt_blocked:
                    if not start_is_blocked: continue
                    
                step_cost = math.sqrt(dx * dx + dy * dy)
                cost_multiplier = 100.0 if is_nxt_blocked else 1.0
                tentative = g_score[current] + step_cost * cost_multiplier'''

new_block = '''                is_nxt_blocked = blocked(nxt)
                
                # Cannot enter a blocked cell from a free cell. Can only move through blocked if escaping.
                if is_nxt_blocked and nxt != goal_c:
                    if not blocked(current):
                        continue
                    cost_multiplier = 100.0
                else:
                    cost_multiplier = 1.0
                    
                step_cost = math.sqrt(dx * dx + dy * dy)
                tentative = g_score[current] + step_cost * cost_multiplier'''

if old_block in content:
    content = content.replace(old_block, new_block)
    with open('dashboard_bridge_node.py', 'w') as f:
        f.write(content)
    print('A-star logic patched successfully.')
else:
    print('Error: Could not find A-star logic to patch.')
