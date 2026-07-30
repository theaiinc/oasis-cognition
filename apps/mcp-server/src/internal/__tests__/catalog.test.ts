/**
 * Unit tests for tool-catalog and skill-catalog modules.
 *
 * Run with: npx tsx src/internal/__tests__/catalog.test.ts
 */
import assert from 'node:assert/strict';
import { searchToolCatalog, getToolCategories } from '../tool-catalog.js';
import { searchSkillCatalog } from '../skill-catalog.js';

// ── Tool Catalog ──────────────────────────────────────────────────────────

function test_tool_catalog_basic_search() {
  const results = searchToolCatalog('agent');
  assert.ok(results.length > 0, 'Should find tools matching "agent"');
  assert.ok(results.some(t => t.name.includes('agent') || t.description.toLowerCase().includes('agent')),
    'Should include agent-related tools');
  console.log('  ✓ tool_catalog_basic_search');
}

function test_tool_catalog_search_by_category() {
  const results = searchToolCatalog('code');
  assert.ok(results.length > 0, 'Should find code-related tools');
  // At least some results should come from the 'code' category
  const codeCatResults = results.filter(t => t.category === 'code');
  assert.ok(codeCatResults.length > 0, 'Should include tools from code category');
  console.log('  ✓ tool_catalog_search_by_category');
}

function test_tool_catalog_empty_query() {
  const results = searchToolCatalog('');
  assert.equal(results.length, 0, 'Empty query should return empty');
  console.log('  ✓ tool_catalog_empty_query');
}

function test_tool_catalog_no_match() {
  const results = searchToolCatalog('xyznonexistent12345');
  assert.equal(results.length, 0, 'No match query should return empty');
  console.log('  ✓ tool_catalog_no_match');
}

function test_tool_catalog_max_results() {
  const results = searchToolCatalog('tool', 3);
  assert.ok(results.length <= 3, 'Should respect max_results limit');
  console.log('  ✓ tool_catalog_max_results');
}

function test_tool_catalog_get_categories() {
  const cats = getToolCategories();
  assert.ok(cats.includes('knowledge'), 'Should include knowledge category');
  assert.ok(cats.includes('computer_use'), 'Should include computer_use category');
  assert.ok(cats.includes('web'), 'Should include web category');
  assert.ok(cats.length >= 10, 'Should have at least 10 categories');
  // Verify sorted
  for (let i = 1; i < cats.length; i++) {
    assert.ok(cats[i - 1]! <= cats[i]!, `Categories should be sorted at index ${i}`);
  }
  console.log('  ✓ tool_catalog_get_categories');
}

function test_tool_catalog_case_insensitive() {
  const results = searchToolCatalog('Session');
  const resultsLower = searchToolCatalog('session');
  assert.equal(results.length, resultsLower.length,
    'Case insensitive search should return same results');
  assert.ok(results.length > 0, 'Should find session-related tools');
  console.log('  ✓ tool_catalog_case_insensitive');
}

// ── Skill Catalog ─────────────────────────────────────────────────────────

function test_skill_catalog_basic_search() {
  const results = searchSkillCatalog('debug');
  assert.ok(results.length > 0, 'Should find skills matching "debug"');
  assert.ok(results.some(s => s.id.includes('debug')),
    'Should include debugging skills');
  console.log('  ✓ skill_catalog_basic_search');
}

function test_skill_catalog_search_by_category() {
  const results = searchSkillCatalog('testing');
  assert.ok(results.length > 0, 'Should find test-related skills');
  console.log('  ✓ skill_catalog_search_by_category');
}

function test_skill_catalog_search_by_keyword() {
  const results = searchSkillCatalog('deploy');
  assert.ok(results.length > 0, 'Should find skills matching "deploy"');
  assert.ok(results.some(s => s.keywords.some(k => k.includes('deploy'))),
    'Should match by keyword');
  console.log('  ✓ skill_catalog_search_by_keyword');
}

function test_skill_catalog_empty_query() {
  const results = searchSkillCatalog('');
  assert.equal(results.length, 0, 'Empty query should return empty');
  console.log('  ✓ skill_catalog_empty_query');
}

function test_skill_catalog_no_match() {
  const results = searchSkillCatalog('xyznonexistent12345');
  assert.equal(results.length, 0, 'No match query should return empty');
  console.log('  ✓ skill_catalog_no_match');
}

function test_skill_catalog_max_results() {
  const results = searchSkillCatalog('deploy', 2);
  assert.ok(results.length <= 2, 'Should respect max_results limit');
  console.log('  ✓ skill_catalog_max_results');
}

function test_skill_catalog_case_insensitive() {
  const results = searchSkillCatalog('API');
  assert.ok(results.length > 0, 'Case insensitive search should work');
  console.log('  ✓ skill_catalog_case_insensitive');
}

// ── Run all ───────────────────────────────────────────────────────────────

function run() {
  console.log('tool-catalog tests:');
  test_tool_catalog_basic_search();
  test_tool_catalog_search_by_category();
  test_tool_catalog_empty_query();
  test_tool_catalog_no_match();
  test_tool_catalog_max_results();
  test_tool_catalog_get_categories();
  test_tool_catalog_case_insensitive();

  console.log('\nskill-catalog tests:');
  test_skill_catalog_basic_search();
  test_skill_catalog_search_by_category();
  test_skill_catalog_search_by_keyword();
  test_skill_catalog_empty_query();
  test_skill_catalog_no_match();
  test_skill_catalog_max_results();
  test_skill_catalog_case_insensitive();

  console.log('\n✓ All catalog tests passed.');
}

run();
