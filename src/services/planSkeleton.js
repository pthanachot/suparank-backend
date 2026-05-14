/**
 * Build an initial Plan skeleton from a Content document, optionally carrying
 * forward strategic + deliberative + evidentiary state from a prior plan.
 *
 * Lives outside the controller so unit tests can exercise the carry-forward
 * contract directly. (Bug 2 fix.)
 */

function deepClone(item) {
  if (item == null) return item;
  if (typeof item.toObject === 'function') return item.toObject();
  return JSON.parse(JSON.stringify(item));
}

function buildSkeleton({ content, version, parentVersion = null, carryFrom = null }) {
  const skeleton = {
    contentId: content._id,
    workspaceId: content.workspaceId,
    contentNumber: content.contentNumber,
    version,
    parentVersion,
    status: 'draft',
    targetAudience: '',
    angle: '',
    thesis: '',
    differentiation: [],
    sections: [],
    wordBudget: content.targetWordCount || 0,
    evidenceMap: {},
    sources: [],
    alternatives: [],
    risks: [],
    openQuestions: [],
    predictedSeoScore: 0,
    evidenceVerified: false,
  };

  if (carryFrom) {
    skeleton.targetAudience = carryFrom.targetAudience || '';
    skeleton.angle = carryFrom.angle || '';
    skeleton.thesis = carryFrom.thesis || '';
    skeleton.differentiation = (carryFrom.differentiation || []).map(deepClone);
    skeleton.sections = (carryFrom.sections || []).map(deepClone);
    skeleton.wordBudget = carryFrom.wordBudget || skeleton.wordBudget;
    skeleton.evidenceMap = JSON.parse(JSON.stringify(carryFrom.evidenceMap || {}));
    skeleton.alternatives = (carryFrom.alternatives || []).map(deepClone);
    skeleton.risks = (carryFrom.risks || []).map(deepClone);
    skeleton.openQuestions = (carryFrom.openQuestions || []).map(deepClone);
    skeleton.sources = (carryFrom.sources || []).map(deepClone);
  }

  return skeleton;
}

/**
 * Build the brief that planValidator.validateCompleteness expects, from the
 * actual Content fields. Content.contentBrief is a curated payload from the
 * analysis pipeline (curateContentBrief in analysisController) and does NOT
 * carry targetWordCount or subtopics — those live elsewhere on Content. If
 * we pass content.contentBrief directly, the validator's word-budget check
 * silently skips (since brief.targetWordCount is undefined). (Bug #3 fix
 * from second-round review.)
 */
function buildValidatorBrief(content) {
  if (!content) return null;
  const benchmark = content.benchmark || {};
  return {
    targetWordCount: content.targetWordCount || 0,
    subtopics: Array.isArray(benchmark.subtopics) ? benchmark.subtopics : [],
  };
}

module.exports = { buildSkeleton, buildValidatorBrief, deepClone };
