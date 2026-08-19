'use strict';

const config = require('./config');
const provider = require('./aiProvider');

function clean(value) {
  return String(value || '').trim();
}

function chooseOwner(members, keywords = []) {
  if (!members.length) return null;
  const scored = members.map(member => {
    const haystack = `${member.full_name || ''} ${member.username || ''} ${member.role || ''}`.toLowerCase();
    const score = keywords.reduce((total, keyword) => total + (haystack.includes(keyword) ? 1 : 0), 0);
    return { id: member.user_id || member.id, score };
  }).sort((a, b) => b.score - a.score || a.id - b.id);
  return scored[0]?.id || null;
}

function proposePlan(project, members, brief = '') {
  const objective = clean(project.objective) || clean(brief) || `Deliver ${project.name}`;
  const pm = chooseOwner(members, ['ceo', 'admin', 'moderator', 'project']);
  const builder = chooseOwner(members, ['developer', 'engineer', 'backend', 'frontend', 'member']);
  const reviewer = chooseOwner(members, ['moderator', 'admin', 'quality', 'test']);
  const tasks = [
    ['Discovery', 'Confirm objectives and success measures', `Confirm the intended outcome for: ${objective}`, pm, 'high', 'Objectives, success measures, constraints, and unresolved questions are documented and approved.', []],
    ['Discovery', 'Validate scope and assumptions', `Review the stored scope, constraints, assumptions, and source brief for ${project.name}.`, pm, 'high', 'Scope boundaries and assumptions are traceable to approved records.', [0]],
    ['Planning', 'Create delivery milestones', 'Convert the approved scope into sequenced milestones with owners and measurable outcomes.', pm, 'high', 'Milestones, owners, dependencies, and review points are recorded.', [1]],
    ['Design', 'Prepare solution and user workflow', 'Define the proposed workflow, data needs, permissions, and acceptance criteria.', builder, 'medium', 'The proposed design is reviewed and covers the approved scope.', [1]],
    ['Build', 'Implement approved project scope', 'Build only the approved requirements and record implementation evidence.', builder, 'high', 'Approved requirements are implemented and linked to verification evidence.', [2, 3]],
    ['Quality', 'Verify acceptance criteria', 'Test the implemented work against stored acceptance criteria and record defects.', reviewer, 'high', 'Verification results and unresolved defects are recorded.', [4]],
    ['Launch', 'Complete launch readiness review', 'Review security, support, documentation, communications, and rollback readiness.', pm, 'high', 'Launch readiness is approved by an authorized workspace manager.', [5]],
    ['Operations', 'Publish factual project update', 'Generate a status update from stored task, risk, decision, and change records.', pm, 'medium', 'The update contains no unsupported completion claims.', [6]]
  ];
  return tasks.map(([phase, title, description, ownerId, priority, acceptanceCriteria, depends]) => ({
    phase,
    title,
    description,
    owner_id: ownerId,
    priority,
    status: 'not_started',
    progress: 0,
    acceptance_criteria: acceptanceCriteria,
    due_date: null,
    depends_on_proposal_indexes: depends
  }));
}

function parseMeetingNotes(notes, members) {
  const memberNames = members.map(member => member.full_name).filter(Boolean);
  const sentences = String(notes).split(/(?<=[.!?])\s+|\n+/).map(value => value.trim()).filter(value => value.length >= 5);
  const suggestions = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const ownerName = memberNames.find(name => lower.includes(name.toLowerCase())) || '';
    if (/\b(decided|decision|agreed|approved)\b/.test(lower)) {
      suggestions.push({
        suggestion_type: 'decision',
        payload: { title: sentence.slice(0, 120), detail: sentence, owner: ownerName },
        rationale: 'Decision-oriented language was detected.',
        evidence: sentence
      });
    } else if (/\b(blocked|blocker|waiting|cannot|dependency|risk)\b/.test(lower)) {
      suggestions.push({
        suggestion_type: 'risk',
        payload: { risk_type: 'meeting_note', severity: /critical|urgent/.test(lower) ? 'high' : 'medium', title: sentence.slice(0, 120), description: sentence },
        rationale: 'Risk or blocker language was detected.',
        evidence: sentence
      });
    } else if (/\b(will|must|needs? to|action|follow[- ]?up|todo|assign)\b/.test(lower)) {
      suggestions.push({
        suggestion_type: 'task',
        payload: {
          phase: 'Meeting Follow-up',
          title: sentence.slice(0, 120),
          description: sentence,
          owner_name: ownerName,
          priority: /urgent|critical|must/.test(lower) ? 'high' : 'medium',
          acceptance_criteria: 'The stated follow-up is completed and supporting evidence is recorded.'
        },
        rationale: 'Action-oriented language was detected.',
        evidence: sentence
      });
    }
  }
  if (!suggestions.length) {
    suggestions.push({
      suggestion_type: 'clarification',
      payload: { question: 'No explicit action, decision, or blocker was detected. Please review the notes manually.' },
      rationale: 'The notes did not contain sufficiently explicit project language.',
      evidence: String(notes).slice(0, 300)
    });
  }
  return suggestions;
}

function analyzeChange(description, taskCount, activeOwnerCounts) {
  const lower = String(description).toLowerCase();
  const overloaded = Object.entries(activeOwnerCounts).filter(([, count]) => count >= 5).map(([name]) => name);
  return {
    impact_scope: /\b(add|new|extra|include|support)\b/.test(lower) ? 'Likely scope expansion' : 'Scope effect requires review',
    impact_effort: /\b(redesign|migration|integration|replace|all users)\b/.test(lower) ? 'High' : 'Medium',
    impact_dependencies: taskCount ? 'Re-check downstream build, test, and delivery dependencies.' : 'No stored tasks exist; dependency effect cannot yet be measured.',
    impact_workload: overloaded.length ? `Potential overload for: ${overloaded.join(', ')}` : 'No current owner overload is shown by stored active-task counts.'
  };
}

function risk(type, severity, title, description, evidence) {
  return { risk_type: type, severity, title, description, evidence };
}

function scanRisks(tasks, members, dependencies) {
  const results = [];
  const memberMap = new Map(members.map(member => [Number(member.user_id || member.id), member]));
  const taskMap = new Map(tasks.map(task => [Number(task.id), task]));
  const activeByOwner = new Map();
  const today = new Date().toISOString().slice(0, 10);

  for (const task of tasks) {
    if (task.status !== 'done' && task.owner_id) {
      const list = activeByOwner.get(Number(task.owner_id)) || [];
      list.push(task);
      activeByOwner.set(Number(task.owner_id), list);
    }
    if (!task.owner_id && task.status !== 'done') results.push(risk('ownership', 'medium', `Unowned task: ${task.title}`, 'The task has no responsible owner.', `Task #${task.id} owner_id is empty.`));
    if (task.status === 'blocked') results.push(risk('blocker', 'high', `Blocked task: ${task.title}`, 'The stored task state is blocked.', `Task #${task.id} status=blocked.`));
    if (task.status === 'done' && Number(task.progress) < 100) results.push(risk('conflict', 'high', `Contradictory task record: ${task.title}`, 'A completed task has progress below 100%.', `Task #${task.id} status=done but progress=${task.progress}%.`));
    if (task.status === 'not_started' && Number(task.progress) > 0) results.push(risk('conflict', 'medium', `Contradictory task record: ${task.title}`, 'A not-started task has recorded progress.', `Task #${task.id} status=not_started but progress=${task.progress}%.`));
    if (['high', 'critical'].includes(task.priority) && !clean(task.acceptance_criteria)) results.push(risk('requirement', 'medium', `Missing completion criteria: ${task.title}`, 'A high-priority task lacks acceptance criteria.', `Task #${task.id} acceptance_criteria is empty.`));
    if (task.due_date && task.status !== 'done' && /^\d{4}-\d{2}-\d{2}$/.test(task.due_date) && task.due_date < today) results.push(risk('schedule', 'high', `Overdue task: ${task.title}`, 'The task due date has passed and it is not complete.', `Task #${task.id} due_date=${task.due_date}, status=${task.status}.`));
  }

  for (const [ownerId, ownerTasks] of activeByOwner.entries()) {
    const member = memberMap.get(ownerId);
    const capacity = Number(member?.capacity || 5);
    if (ownerTasks.length > capacity) {
      const name = member?.full_name || `User ${ownerId}`;
      results.push(risk('workload', 'high', `Owner workload exceeds capacity: ${name}`, `${ownerTasks.length} active tasks exceed the stored capacity of ${capacity}.`, `Active task IDs: ${ownerTasks.map(task => task.id).join(', ')}`));
    }
  }

  for (const dependency of dependencies) {
    const task = taskMap.get(Number(dependency.task_id));
    const prerequisite = taskMap.get(Number(dependency.depends_on_task_id));
    if (task && prerequisite && ['in_progress', 'done'].includes(task.status) && prerequisite.status !== 'done') {
      results.push(risk('dependency', 'high', `Unresolved prerequisite for: ${task.title}`, 'Work has advanced while a prerequisite is not complete.', `Task #${task.id} depends on task #${prerequisite.id} with status=${prerequisite.status}.`));
    }
  }
  return results;
}

function externalModelEnabled() {
  return provider.enabled();
}

function aiStatus() {
  return provider.status();
}

function memberSummary(members) {
  return (members || []).map(member => ({
    user_id: Number(member.user_id || member.id),
    full_name: member.full_name || '',
    role: member.role || '',
    department: member.department || 'General',
    current_status: member.current_status || 'offline',
    status_key: member.status_key || 'free',
    status_label: member.status_label || member.status_key || 'Free',
    capacity: Number(member.capacity || 5),
    active_task_count: Number(member.active_task_count || 0)
  }));
}

function projectContext(project, extra = {}) {
  return {
    id: Number(project.id),
    name: clean(project.name),
    objective: clean(project.objective),
    scope: clean(project.scope),
    constraints: clean(project.constraints),
    assumptions: clean(project.assumptions),
    status: clean(project.status),
    ...extra
  };
}

const childWorkItemSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    assignee_id: { type: ['integer', 'null'] },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    acceptance_criteria: { type: 'string' },
    due_date: { type: ['string', 'null'] },
    estimate_minutes: { type: 'integer' }
  },
  required: ['title', 'description', 'assignee_id', 'priority', 'acceptance_criteria', 'due_date', 'estimate_minutes']
};

const directSubtaskSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    assignee_id: { type: ['integer', 'null'] },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    acceptance_criteria: { type: 'string' },
    due_date: { type: ['string', 'null'] },
    estimate_minutes: { type: 'integer' },
    complexity: { type: 'string', enum: ['small', 'medium', 'heavy'] },
    child_tasks: { type: 'array', items: childWorkItemSchema, maxItems: 8 }
  },
  required: ['title', 'description', 'assignee_id', 'priority', 'acceptance_criteria', 'due_date', 'estimate_minutes', 'complexity', 'child_tasks']
};

const projectBlueprintSchema = {
  type: 'object',
  properties: {
    project_name: { type: 'string' },
    project_summary: { type: 'string' },
    main_tasks: {
      type: 'array',
      minItems: 6,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          manager_id: { type: ['integer', 'null'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          acceptance_criteria: { type: 'string' },
          due_date: { type: ['string', 'null'] },
          estimate_minutes: { type: 'integer' },
          subtasks: { type: 'array', items: directSubtaskSchema, minItems: 6, maxItems: 12 }
        },
        required: ['title', 'description', 'manager_id', 'priority', 'acceptance_criteria', 'due_date', 'estimate_minutes', 'subtasks']
      }
    }
  },
  required: ['project_name', 'project_summary', 'main_tasks']
};

function rankedAvailableMembers(members) {
  const presenceScore = { online: 0, away: 1, offline: 3, dnd: 5 };
  const workStatusPenalty = {
    free: 0, available: 0, on_work: 0, work_from_home: 0, remote: 0,
    busy: 2, in_meeting: 3, focus: 3, dnd: 8, on_leave: 12, travelling: 10, custom: 1
  };
  return memberSummary(members).sort((a, b) => {
    const aScore = (workStatusPenalty[a.status_key] ?? 1) + (presenceScore[a.current_status] ?? 2) + Math.min(10, a.active_task_count) / Math.max(1, a.capacity);
    const bScore = (workStatusPenalty[b.status_key] ?? 1) + (presenceScore[b.current_status] ?? 2) + Math.min(10, b.active_task_count) / Math.max(1, b.capacity);
    return aScore - bScore || a.active_task_count - b.active_task_count || a.user_id - b.user_id;
  });
}

function assignableMembers(members) {
  const ranked = rankedAvailableMembers(members);
  const eligible = ranked.filter(member => !['on_leave', 'travelling', 'dnd'].includes(member.status_key));
  return eligible.length ? eligible : ranked;
}

function titleWord(value) {
  const word = clean(value);
  if (!word) return '';
  if (/^(crm|erp|hr|ai|seo|pos)$/i.test(word)) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function conciseProjectName(brief, suggested = '') {
  const normalizeWords = value => clean(value)
    .replace(/^project\s*[:\-]\s*/i, '')
    .replace(/[^a-zA-Z0-9&+\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const suggestedClean = normalizeWords(suggested);
  const suggestedWords = suggestedClean.split(' ').filter(Boolean);
  const sentenceLikeStart = /^(we|i|our|the|a|an|create|build|develop|design|make|need|want|looking|looking-to|looking\s+to)\b/i;
  if (suggestedWords.length >= 2 && suggestedWords.length <= 3 && suggestedClean.length <= 48 && !sentenceLikeStart.test(suggestedClean)) {
    return suggestedWords.map(titleWord).join(' ').slice(0, 60);
  }

  const source = normalizeWords(brief || suggestedClean).toLowerCase();
  if (!source) return 'AI Project';

  const typeRules = [
    [/\b(?:online|e-?commerce)\s+(?:store|shop)\b/, 'Store'],
    [/\bmarketplace\b/, 'Marketplace'],
    [/\bportal\b/, 'Portal'],
    [/\bdashboard\b/, 'Dashboard'],
    [/\bwebsite\b|\bweb\s+site\b/, 'Website'],
    [/\bmobile\s+app(?:lication)?\b|\bweb\s+app(?:lication)?\b|\bapp(?:lication)?\b/, 'App'],
    [/\bcrm\b/, 'CRM'],
    [/\berp\b/, 'ERP'],
    [/\bplatform\b/, 'Platform'],
    [/\bstore\b|\bshop\b/, 'Store'],
    [/\bsystem\b/, 'System'],
    [/\bcampaign\b/, 'Campaign']
  ];
  const type = typeRules.find(([pattern]) => pattern.test(source))?.[1] || 'Project';

  const phraseRules = [
    [/\bfood\s+delivery\b/, 'Food Delivery'],
    [/\breal\s+estate\b/, 'Real Estate'],
    [/\bproject\s+management\b/, 'Project Management'],
    [/\bcustomer\s+(?:support|service)\b/, 'Customer Support'],
    [/\bdigital\s+marketing\b/, 'Digital Marketing'],
    [/\bonline\s+learning\b|\be-?learning\b/, 'Online Learning']
  ];
  let domain = phraseRules.find(([pattern]) => pattern.test(source))?.[1] || '';

  if (!domain) {
    const domainRules = [
      [/\bfootwear\b|\bshoes?\b|\bslippers?\b|\bsandals?\b|\bchappals?\b/, 'Footwear'],
      [/\bpharmacy\b|\bmedical\b|\bmedicine\b|\bhealthcare\b/, 'Pharmacy'],
      [/\binventory\b|\bstock\b/, 'Inventory'],
      [/\brestaurant\b|\bfood\b|\bmeal\b/, 'Food'],
      [/\beducation\b|\bschool\b|\bstudent\b|\bcourse\b/, 'Education'],
      [/\bfinance\b|\bfintech\b|\bbanking\b|\bpayment\b/, 'Fintech'],
      [/\bproperty\b|\brealty\b/, 'Property'],
      [/\btravel\b|\btourism\b|\btour\b/, 'Travel'],
      [/\bfashion\b|\bclothing\b|\bapparel\b|\bgarment\b/, 'Fashion'],
      [/\bbooking\b|\breservation\b/, 'Booking'],
      [/\bemployee\b|\bhuman\s+resources\b|\bhr\b/, 'HR'],
      [/\bcustomer\b|\bclient\b/, 'Customer']
    ];
    domain = domainRules.find(([pattern]) => pattern.test(source))?.[1] || '';
  }

  if (!domain) {
    const stop = new Set(['we','i','our','the','a','an','and','or','to','for','of','in','on','with','from','by','is','are','be','being','been','build','create','develop','design','make','launch','complete','new','growing','secure','proper','full','looking','want','need','project','online','web','mobile','store','shop','website','portal','platform','dashboard','system','app','application']);
    const words = source.split(' ').map(word => word.replace(/^-+|-+$/g, '')).filter(word => word && !stop.has(word) && word.length > 2);
    domain = words.slice(0, 2).map(titleWord).join(' ');
  }

  let parts = domain ? domain.split(' ') : [];
  if (type !== 'Project' && !parts.some(part => part.toLowerCase() === type.toLowerCase())) parts.push(type);
  if (!parts.length) parts = ['AI', 'Project'];
  if (parts.length === 1) parts.push('Project');
  return parts.slice(0, 3).map(titleWord).join(' ').slice(0, 60);
}

function inferredProjectName(brief) {
  return conciseProjectName(brief);
}

function localProjectBlueprint(brief, members) {
  const people = assignableMembers(members);
  const managerFor = index => people.length ? people[index % people.length].user_id : null;
  let assignmentCursor = 0;
  const nextAssignee = () => people.length ? people[(assignmentCursor++) % people.length].user_id : null;
  const context = clean(brief).slice(0, 1200);
  const makeChildren = (mainIndex, subIndex, labels) => labels.map((label, childIndex) => ({
    title: label,
    description: `${label}. Keep the outcome small, verifiable, and traceable to the parent subtask and project brief.`,
    assignee_id: nextAssignee(),
    priority: childIndex === 0 ? 'high' : 'medium',
    acceptance_criteria: 'The child task has a concrete completed output that can be reviewed independently.',
    due_date: null,
    estimate_minutes: 120
  }));
  const main = [
    {
      title: 'Discovery, scope and success criteria',
      description: `Understand the brief deeply and turn it into agreed goals, scope boundaries, constraints, dependencies, risks, and measurable outcomes. Brief context: ${context}`,
      priority: 'high',
      acceptance_criteria: 'Project goals, scope, constraints, assumptions, dependencies, risks, and success criteria are explicit and reviewable.',
      subtasks: [
        ['Extract goals and deliverables', 'Identify every concrete outcome and deliverable supported by the brief.', 'medium', []],
        ['Map users, stakeholders and needs', 'Identify the people or groups affected and the outcomes they need.', 'medium', []],
        ['Document scope boundaries', 'Separate in-scope work from assumptions, optional work, and out-of-scope requests.', 'medium', []],
        ['Identify constraints and dependencies', 'Capture schedule, technical, operational, approval, and external dependencies.', 'heavy', ['List hard constraints', 'Map external dependencies', 'Record unresolved questions']],
        ['Define measurable success criteria', 'Create project-level completion and quality criteria that can be verified.', 'medium', []]
      ]
    },
    {
      title: 'Solution design and delivery architecture',
      description: 'Convert the agreed scope into a practical solution, workflow, structure, ownership model, and execution sequence.',
      priority: 'high',
      acceptance_criteria: 'The solution approach, workflow, major components, handoffs, and execution sequence are clear enough to build.',
      subtasks: [
        ['Design the end-to-end workflow', 'Map how the requested outcome should work from start to finish.', 'heavy', ['Map primary flow', 'Map edge cases and failure states', 'Review workflow against scope']],
        ['Define major components or work packages', 'Break the solution into coherent areas that can be owned and delivered independently.', 'medium', []],
        ['Define data, content or asset needs', 'List the information, assets, content, integrations, or inputs required to execute.', 'medium', []],
        ['Define permissions and responsibilities', 'Clarify who can create, review, approve, change, or operate each part.', 'medium', []],
        ['Prepare implementation sequence', 'Order the work based on dependencies and the shortest safe path to delivery.', 'medium', []]
      ]
    },
    {
      title: 'Core implementation and primary deliverables',
      description: 'Build the main project output in small, testable units rather than one oversized execution task.',
      priority: 'high',
      acceptance_criteria: 'Core scope is implemented in reviewable units and each unit meets its task-level acceptance criteria.',
      subtasks: [
        ['Prepare implementation foundation', 'Create the baseline structure, environments, templates, or working setup needed for delivery.', 'heavy', ['Set up working structure', 'Configure required environments or tools', 'Verify the baseline setup']],
        ['Build primary user-facing or business flow', 'Implement the most important end-to-end outcome described in the brief.', 'heavy', ['Build the first functional slice', 'Handle validation and edge cases', 'Connect dependent components', 'Run focused verification']],
        ['Build supporting workflows', 'Implement secondary flows required for the primary outcome to work reliably.', 'heavy', ['Implement secondary flow A', 'Implement secondary flow B', 'Verify handoffs between flows']],
        ['Implement controls, validation and error handling', 'Add the safeguards and feedback needed for reliable operation.', 'medium', []],
        ['Review implementation against scope', 'Check that built work maps back to approved requirements and no major requirement was skipped.', 'medium', []]
      ]
    },
    {
      title: 'Integrations, content and operational readiness',
      description: 'Complete supporting integrations, data/content preparation, permissions, documentation, and operational details needed for a usable result.',
      priority: 'high',
      acceptance_criteria: 'Supporting systems, content, permissions, documentation, and operational handoffs are ready for testing and use.',
      subtasks: [
        ['Complete required integrations or handoffs', 'Connect external/internal dependencies needed by the core solution.', 'heavy', ['Configure connection points', 'Map required inputs and outputs', 'Test success and failure paths']],
        ['Prepare required data, content or assets', 'Create, import, organize, or validate the inputs needed for launch.', 'medium', []],
        ['Configure roles and access', 'Apply the required ownership, access, review, and approval rules.', 'medium', []],
        ['Prepare user and operator documentation', 'Document how to use, manage, support, and troubleshoot the delivered solution.', 'medium', []],
        ['Run readiness review', 'Confirm supporting work is complete enough to enter final QA.', 'medium', []]
      ]
    },
    {
      title: 'Quality assurance, fixes and acceptance',
      description: 'Verify the project systematically against requirements and acceptance criteria, then resolve material issues.',
      priority: 'high',
      acceptance_criteria: 'Critical paths are verified, material defects are resolved, and acceptance evidence is recorded.',
      subtasks: [
        ['Prepare test and review checklist', 'Turn requirements and acceptance criteria into a structured verification plan.', 'medium', []],
        ['Test primary flows', 'Verify the most important end-to-end paths and expected outcomes.', 'heavy', ['Test happy paths', 'Test validation and negative cases', 'Test permissions and ownership', 'Record defects and evidence']],
        ['Test secondary and edge-case flows', 'Verify supporting scenarios, boundary conditions, and failure states.', 'medium', []],
        ['Resolve defects and gaps', 'Fix or close material findings and retest affected areas.', 'heavy', ['Prioritize findings', 'Fix critical/high issues', 'Retest fixes', 'Close or document remaining accepted risks']],
        ['Complete acceptance review', 'Compare final results against project and task-level completion criteria.', 'medium', []]
      ]
    },
    {
      title: 'Launch, handoff and post-launch follow-through',
      description: 'Deliver or launch the approved result safely, hand over ownership, and define immediate follow-up actions.',
      priority: 'high',
      acceptance_criteria: 'Launch/handoff is completed with ownership, documentation, verification, and immediate follow-up clearly recorded.',
      subtasks: [
        ['Prepare launch or handoff checklist', 'Confirm prerequisites, owners, communications, backups/rollback, and final approvals.', 'medium', []],
        ['Execute launch or final delivery', 'Perform the approved release, delivery, migration, publication, or handoff steps.', 'heavy', ['Complete pre-launch checks', 'Execute release or handoff', 'Verify live/final state', 'Record completion evidence']],
        ['Confirm ownership and support path', 'Make ongoing responsibility, escalation, and support expectations explicit.', 'medium', []],
        ['Monitor immediate outcomes', 'Check the delivered result for early issues or unexpected behavior.', 'medium', []],
        ['Close project and capture next actions', 'Record final status, accepted risks, follow-up tasks, and lessons or next-phase items.', 'medium', []]
      ]
    }
  ];
  const expansionByMain = [
    [
      ['Resolve open questions and approvals', 'Collect unresolved decisions, assign owners, and close the questions that would block execution.', 'medium', []],
      ['Create scope traceability checklist', 'Map each approved deliverable to an owner and a verifiable completion check.', 'medium', []]
    ],
    [
      ['Review solution risks and tradeoffs', 'Identify design tradeoffs, failure modes, and decisions that require explicit acceptance.', 'medium', []],
      ['Prepare delivery handoff notes', 'Document interfaces, dependencies, and ownership so implementation teams can execute without ambiguity.', 'medium', []]
    ],
    [
      ['Complete secondary implementation slice', 'Deliver another independently testable slice of the core project scope.', 'heavy', ['Prepare the slice', 'Implement the slice', 'Verify the slice']],
      ['Refactor and stabilize core work', 'Reduce avoidable complexity and make the main implementation easier to maintain and verify.', 'medium', []]
    ],
    [
      ['Verify integration data quality', 'Validate the inputs, outputs, mappings, and error handling across supporting integrations.', 'heavy', ['Validate inputs', 'Validate outputs', 'Test recovery paths']],
      ['Prepare operational ownership matrix', 'Document who owns routine operations, approvals, escalation, and support after handoff.', 'medium', []]
    ],
    [
      ['Run regression verification', 'Retest affected areas after fixes so resolved defects do not create new failures.', 'heavy', ['Select regression coverage', 'Run regression checks', 'Record evidence and remaining risks']],
      ['Prepare acceptance evidence pack', 'Collect the test evidence, sign-offs, and traceability needed for final acceptance.', 'medium', []]
    ],
    [
      ['Prepare post-launch issue triage', 'Define how launch issues will be captured, prioritized, assigned, and resolved.', 'medium', []],
      ['Run post-launch review', 'Review early outcomes, unresolved risks, and next-phase improvements after delivery.', 'medium', []]
    ]
  ];
  main.forEach((item, index) => {
    for (const extra of expansionByMain[index] || []) if (item.subtasks.length < 7) item.subtasks.push(extra);
  });
  return {
    project_name: inferredProjectName(brief),
    project_summary: clean(brief).slice(0, 2000),
    main_tasks: main.map((item, mainIndex) => ({
      title: item.title,
      description: item.description,
      manager_id: managerFor(mainIndex),
      priority: item.priority,
      acceptance_criteria: item.acceptance_criteria,
      due_date: null,
      estimate_minutes: 0,
      subtasks: item.subtasks.map(([title, description, complexity, childLabels], subIndex) => ({
        title,
        description,
        assignee_id: nextAssignee(),
        priority: subIndex <= 1 ? item.priority : 'medium',
        acceptance_criteria: 'The subtask outcome is complete, reviewed, and traceable to the parent main task and project brief.',
        due_date: null,
        estimate_minutes: complexity === 'heavy' ? 480 : 180,
        complexity,
        child_tasks: makeChildren(mainIndex, subIndex, childLabels)
      }))
    }))
  };
}

function normalizeBlueprint(raw, members, brief) {
  const people = assignableMembers(members);
  const allowed = new Set(people.map(member => member.user_id));
  const fallbackOwner = people[0]?.user_id || null;
  const priorityOf = value => ['low', 'medium', 'high', 'critical'].includes(value) ? value : 'medium';
  const dateOf = value => { const due = clean(value); return /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null; };
  const estimateOf = value => Math.max(0, Math.min(525600, Math.round(Number(value) || 0)));
  const ownerOf = (candidate, fallback) => {
    const value = Number(candidate);
    return allowed.has(value) ? value : (fallback || fallbackOwner || null);
  };
  const normalizeChild = (child, fallbackAssignee) => ({
    title: clean(child?.title).slice(0, 220),
    description: clean(child?.description).slice(0, 10000),
    assignee_id: ownerOf(child?.assignee_id, fallbackAssignee),
    priority: priorityOf(child?.priority),
    acceptance_criteria: clean(child?.acceptance_criteria).slice(0, 10000),
    due_date: dateOf(child?.due_date),
    estimate_minutes: estimateOf(child?.estimate_minutes)
  });
  const mainTasks = (Array.isArray(raw?.main_tasks) ? raw.main_tasks : []).slice(0, 6).map((task, mainIndex) => {
    const managerId = ownerOf(task?.manager_id, people[mainIndex % Math.max(1, people.length)]?.user_id || fallbackOwner);
    const subtasks = (Array.isArray(task?.subtasks) ? task.subtasks : []).slice(0, 12).map((subtask, subIndex) => {
      const assigneeId = ownerOf(subtask?.assignee_id, managerId || people[(mainIndex + subIndex) % Math.max(1, people.length)]?.user_id || fallbackOwner);
      const childTasks = (Array.isArray(subtask?.child_tasks) ? subtask.child_tasks : []).slice(0, 8)
        .map(child => normalizeChild(child, assigneeId))
        .filter(item => item.title);
      const complexity = ['small', 'medium', 'heavy'].includes(subtask?.complexity)
        ? subtask.complexity
        : (childTasks.length ? 'heavy' : (estimateOf(subtask?.estimate_minutes) > 240 ? 'heavy' : 'medium'));
      return {
        title: clean(subtask?.title).slice(0, 220),
        description: clean(subtask?.description).slice(0, 10000),
        assignee_id: assigneeId || null,
        priority: priorityOf(subtask?.priority),
        acceptance_criteria: clean(subtask?.acceptance_criteria).slice(0, 10000),
        due_date: dateOf(subtask?.due_date),
        estimate_minutes: estimateOf(subtask?.estimate_minutes),
        complexity,
        child_tasks: childTasks
      };
    }).filter(item => item.title);
    return {
      title: clean(task?.title).slice(0, 220),
      description: clean(task?.description).slice(0, 10000),
      manager_id: managerId || null,
      priority: priorityOf(task?.priority),
      acceptance_criteria: clean(task?.acceptance_criteria).slice(0, 10000),
      due_date: dateOf(task?.due_date),
      estimate_minutes: estimateOf(task?.estimate_minutes),
      subtasks
    };
  }).filter(item => item.title && item.subtasks.length);
  const normalized = {
    project_name: conciseProjectName(brief, raw?.project_name),
    project_summary: clean(raw?.project_summary).slice(0, 10000) || clean(brief).slice(0, 10000),
    main_tasks: mainTasks
  };
  return balanceBlueprintAssignments(ensureBlueprintDepth(normalized, brief), members);
}

function ensureBlueprintDepth(plan, brief) {
  const local = localProjectBlueprint(brief, []);
  const usedTitles = new Set((plan.main_tasks || []).map(item => String(item.title || '').toLowerCase()));
  for (const fallback of local.main_tasks) {
    if ((plan.main_tasks || []).length >= 6) break;
    if (usedTitles.has(String(fallback.title || '').toLowerCase())) continue;
    plan.main_tasks.push(JSON.parse(JSON.stringify(fallback)));
    usedTitles.add(String(fallback.title || '').toLowerCase());
  }
  plan.main_tasks = (plan.main_tasks || []).slice(0, 6);
  for (const main of plan.main_tasks) {
    const fillers = [
      ['Clarify detailed requirements', 'Resolve the detailed requirements and decisions needed to execute this workstream safely.'],
      ['Prepare execution inputs', 'Collect the assets, access, data, dependencies, and prerequisites needed for this workstream.'],
      ['Execute the next deliverable slice', 'Complete another small, independently verifiable slice of the workstream.'],
      ['Validate edge cases and handoffs', 'Check boundary cases, handoffs, failure states, and ownership gaps for this workstream.'],
      ['Review with the accountable manager', 'Run a focused manager review against scope, quality, and acceptance criteria.'],
      ['Document completion and follow-up', 'Record completion evidence, remaining risks, and follow-up actions for this workstream.']
    ];
    main.subtasks = Array.isArray(main.subtasks) ? main.subtasks.slice(0, 12) : [];
    let fillerIndex = 0;
    while (main.subtasks.length < 6) {
      const [title, description] = fillers[fillerIndex++ % fillers.length];
      main.subtasks.push({
        title: `${title}: ${main.title}`.slice(0,220), description, assignee_id: main.manager_id || null,
        priority:'medium', acceptance_criteria:'The output is complete, reviewable, and linked to the parent workstream.',
        due_date:null, estimate_minutes:180, complexity:'medium', child_tasks:[]
      });
    }
  }
  return plan;
}

function balanceBlueprintAssignments(plan, members) {
  const people = assignableMembers(members);
  if (!people.length) return plan;
  const allowed = new Set(people.map(person => Number(person.user_id)));
  const managerPool = people.filter(person => String(person.role || '').toLowerCase() !== 'ceo');
  const preferredManagers = managerPool.length ? managerPool : people;

  // Main-task ownership: keep a valid AI choice when possible, but diversify
  // managers across the available team. The workspace CEO remains the project
  // manager at project level; these are workstream managers.
  const usedManagers = new Set();
  for (let index = 0; index < (plan.main_tasks || []).length; index += 1) {
    const main = plan.main_tasks[index];
    const current = Number(main.manager_id);
    const currentPerson = people.find(person => Number(person.user_id) === current);
    const currentIsPreferred = currentPerson && (preferredManagers === people || String(currentPerson.role || '').toLowerCase() !== 'ceo');
    if (currentIsPreferred && !usedManagers.has(current)) {
      usedManagers.add(current);
      continue;
    }
    const fresh = preferredManagers.find(person => !usedManagers.has(Number(person.user_id)));
    const replacement = fresh || preferredManagers[index % preferredManagers.length] || people[index % people.length];
    main.manager_id = Number(replacement.user_id);
    usedManagers.add(Number(replacement.user_id));
  }

  const workItems = [];
  for (const main of plan.main_tasks || []) {
    for (const sub of main.subtasks || []) {
      workItems.push({ item: sub, fallback: Number(main.manager_id) || null });
      for (const child of sub.child_tasks || []) workItems.push({ item: child, fallback: Number(sub.assignee_id) || Number(main.manager_id) || null });
    }
  }
  if (!workItems.length) return plan;

  // First remove every Unassigned/invalid owner. Prefer the AI's valid choices;
  // otherwise pick the least-loaded eligible person, considering existing work.
  const assignedCounts = new Map(people.map(person => [Number(person.user_id), 0]));
  const effectiveLoad = person => Number(person.active_task_count || 0) + (assignedCounts.get(Number(person.user_id)) || 0);
  const leastLoaded = () => people.slice().sort((a, b) => {
    const ar = effectiveLoad(a) / Math.max(1, Number(a.capacity || 5));
    const br = effectiveLoad(b) / Math.max(1, Number(b.capacity || 5));
    return ar - br || effectiveLoad(a) - effectiveLoad(b) || Number(a.user_id) - Number(b.user_id);
  })[0];

  for (const entry of workItems) {
    let owner = Number(entry.item.assignee_id);
    if (!allowed.has(owner)) {
      const fallback = allowed.has(Number(entry.fallback)) ? Number(entry.fallback) : Number(leastLoaded()?.user_id || 0);
      owner = fallback || Number(leastLoaded()?.user_id || 0);
      entry.item.assignee_id = owner || null;
    }
    if (allowed.has(owner)) assignedCounts.set(owner, (assignedCounts.get(owner) || 0) + 1);
  }

  // If there are enough generated work items, every eligible person gets work.
  // Reassign from the most-loaded owner to anyone the AI missed.
  if (workItems.length >= people.length) {
    const missing = people.filter(person => (assignedCounts.get(Number(person.user_id)) || 0) === 0);
    for (const person of missing) {
      const targetId = Number(person.user_id);
      let donorIndex = -1;
      let donorScore = -Infinity;
      for (let index = 0; index < workItems.length; index += 1) {
        const owner = Number(workItems[index].item.assignee_id);
        const ownerCount = assignedCounts.get(owner) || 0;
        if (ownerCount <= 1) continue;
        const ownerPerson = people.find(candidate => Number(candidate.user_id) === owner);
        const score = ownerCount + Number(ownerPerson?.active_task_count || 0) / Math.max(1, Number(ownerPerson?.capacity || 5));
        if (score > donorScore) { donorScore = score; donorIndex = index; }
      }
      if (donorIndex < 0) break;
      const previous = Number(workItems[donorIndex].item.assignee_id);
      workItems[donorIndex].item.assignee_id = targetId;
      assignedCounts.set(previous, Math.max(0, (assignedCounts.get(previous) || 0) - 1));
      assignedCounts.set(targetId, 1);
    }
  }

  return plan;
}

async function generateProjectBlueprint(brief, members, workspaceContext = {}) {
  const local = localProjectBlueprint(brief, members);
  if (!provider.enabled()) return { plan: local, provider: 'local_javascript_engine', fallback: true };
  try {
    const result = await provider.generateJson({
      system: 'You are a senior AI project planner and work-breakdown specialist. Read the project brief deeply before proposing work. Produce a review-ready hierarchy with exactly six main workstreams for a normal non-trivial project; never exceed six. The workspace CEO is the project-level manager; do not treat that as a reason to assign every workstream to the CEO. A main task is an accountable workstream owned by a suitable workstream manager. Each main task must be decomposed into concrete executable subtasks. If a subtask is heavy, cross-functional, contains multiple distinct steps, or would reasonably take more than about four hours, decompose it again into smaller child_tasks. Child tasks must be atomic, independently verifiable execution steps. Assign only people from the supplied member list. Balance workload and prefer people whose work status is Free, On Work, or Work From Home and whose department/role fits the work. Avoid assigning On Leave, Travelling, or Do Not Disturb people; use Busy/In a Meeting/Focus only when necessary. Never invent people, completed work, requirements, dates, or expertise not supported by the supplied context. This is a proposal that a human will accept, reject, edit, or regenerate before creation.',
      prompt: `Build a complete project plan from the brief below. Return exactly 6 main_tasks for a normal project and NEVER more than 6. For each main task, return 7 to 12 directly related subtasks when the scope supports it; avoid vague umbrella tasks. Mark each direct subtask complexity as small, medium, or heavy. For a heavy subtask, create 3 to 8 child_tasks that split it into smaller independently actionable steps. Do not create child_tasks for genuinely small atomic work. Aim to make the plan easy to execute without forcing the user to manually break down oversized work. Main-task manager_id is the accountable manager/owner for that workstream. Direct subtask and child task assignee_id is the expected executor. Use only supplied user_id values; use null only if there is genuinely no suitable person. Keep assignments reasonably balanced using active_task_count and capacity. If there are multiple eligible workspace people and enough generated work items, pre-assign EVERY direct subtask and child task to an eligible supplied user_id (never return null while any eligible person exists). If there are multiple eligible workspace people and enough generated work items, use every eligible person at least once across manager, direct-subtask, or child-task ownership; do not concentrate work on one person when others are available. Choose different suitable workstream managers where the team allows it; the CEO remains project manager at the project level. Prefer task estimates that reflect the decomposed work. Use a due date only if the brief contains enough schedule information; otherwise null. IMPORTANT: project_name must be a clean 2-3 word title derived from the brief (for example: Footwear Store, Customer Portal, Inventory System). Never use the full brief, a sentence, or a sentence fragment as project_name.\n\nWorkspace context:\n${JSON.stringify(workspaceContext || {})}\n\nAvailable people:\n${JSON.stringify(memberSummary(members))}\n\nProject brief:\n${clean(brief)}`,
      schema: projectBlueprintSchema
    });
    const plan = normalizeBlueprint(result, members, brief);
    if (plan.main_tasks.length < 6) throw new Error('AI returned too few usable main tasks');
    return { plan, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI project blueprint failed; using local fallback:', error.message);
    return { plan: local, provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}


function normalizeRegeneratedBlueprintItem(level, raw, members, fallbackItem = {}) {
  const people = assignableMembers(members);
  const allowed = new Set(people.map(member => Number(member.user_id)));
  const fallbackOwner = people[0]?.user_id || null;
  const priorityOf = value => ['low','medium','high','critical'].includes(value) ? value : 'medium';
  const dateOf = value => { const due=clean(value); return /^\d{4}-\d{2}-\d{2}$/.test(due)?due:null; };
  const estimateOf = value => Math.max(0,Math.min(525600,Math.round(Number(value)||0)));
  const ownerOf = (candidate,fallback=null) => allowed.has(Number(candidate)) ? Number(candidate) : (allowed.has(Number(fallback)) ? Number(fallback) : fallbackOwner || null);
  const childOf = (item,fallback) => ({
    title: clean(item?.title).slice(0,220) || clean(fallbackItem?.title).slice(0,220) || 'Execution step',
    description: clean(item?.description).slice(0,10000),
    assignee_id: ownerOf(item?.assignee_id,fallback),
    priority: priorityOf(item?.priority), acceptance_criteria: clean(item?.acceptance_criteria).slice(0,10000),
    due_date: dateOf(item?.due_date), estimate_minutes: estimateOf(item?.estimate_minutes)
  });
  if (level === 'child') return childOf(raw, fallbackItem?.assignee_id);
  const assignee = ownerOf(raw?.assignee_id, fallbackItem?.assignee_id);
  if (level === 'sub') return {
    title: clean(raw?.title).slice(0,220) || clean(fallbackItem?.title).slice(0,220) || 'Subtask',
    description: clean(raw?.description).slice(0,10000), assignee_id: assignee,
    priority: priorityOf(raw?.priority), acceptance_criteria: clean(raw?.acceptance_criteria).slice(0,10000),
    due_date: dateOf(raw?.due_date), estimate_minutes: estimateOf(raw?.estimate_minutes),
    complexity: ['small','medium','heavy'].includes(raw?.complexity) ? raw.complexity : ((raw?.child_tasks||[]).length ? 'heavy' : 'medium'),
    child_tasks: (Array.isArray(raw?.child_tasks)?raw.child_tasks:[]).slice(0,8).map(item=>childOf(item,assignee)).filter(item=>item.title)
  };
  const manager = ownerOf(raw?.manager_id, fallbackItem?.manager_id);
  const main = {
    title: clean(raw?.title).slice(0,220) || clean(fallbackItem?.title).slice(0,220) || 'Main workstream',
    description: clean(raw?.description).slice(0,10000), manager_id: manager,
    priority: priorityOf(raw?.priority), acceptance_criteria: clean(raw?.acceptance_criteria).slice(0,10000),
    due_date: dateOf(raw?.due_date), estimate_minutes: estimateOf(raw?.estimate_minutes),
    subtasks: (Array.isArray(raw?.subtasks)?raw.subtasks:[]).slice(0,12).map(sub=>{
      const owner=ownerOf(sub?.assignee_id,manager);
      return { title:clean(sub?.title).slice(0,220), description:clean(sub?.description).slice(0,10000), assignee_id:owner,
        priority:priorityOf(sub?.priority), acceptance_criteria:clean(sub?.acceptance_criteria).slice(0,10000), due_date:dateOf(sub?.due_date), estimate_minutes:estimateOf(sub?.estimate_minutes),
        complexity:['small','medium','heavy'].includes(sub?.complexity)?sub.complexity:((sub?.child_tasks||[]).length?'heavy':'medium'),
        child_tasks:(Array.isArray(sub?.child_tasks)?sub.child_tasks:[]).slice(0,8).map(child=>childOf(child,owner)).filter(child=>child.title) };
    }).filter(sub=>sub.title)
  };
  return balanceBlueprintAssignments({main_tasks:[main]},members).main_tasks[0] || main;
}

async function regenerateProjectBlueprintItem({ level, item, parentMain = null, parentSub = null, brief = '', members = [] }) {
  const allowedLevels = new Set(['main','sub','child']);
  if (!allowedLevels.has(level)) throw new Error('Unsupported project-plan item level');
  const fallback = normalizeRegeneratedBlueprintItem(level,item,members,item);
  if (!provider.enabled()) return { item:fallback, provider:'local_javascript_engine', fallback:true };
  const schema = level === 'main' ? projectBlueprintSchema.properties.main_tasks.items : level === 'sub' ? directSubtaskSchema : childWorkItemSchema;
  const instruction = level === 'main'
    ? 'Regenerate this single main workstream. Keep it aligned to the project brief, but improve decomposition. Return one main task with 7-12 concrete subtasks when scope supports it, and nested child tasks for heavy subtasks.'
    : level === 'sub'
      ? 'Regenerate this single subtask within its parent main workstream. Make it concrete and executable. If it is heavy or multi-step, include useful atomic child_tasks.'
      : 'Regenerate this single nested execution step. Keep it atomic, independently verifiable, and aligned to its parent subtask.';
  try {
    const result = await provider.generateJson({
      system:'You are a senior project planner editing one item inside an already generated work breakdown. Change only the requested item. Use only supplied people IDs, preserve alignment with the project brief and parent context, and do not invent facts.',
      prompt:`${instruction}\n\nProject brief:\n${clean(brief)}\n\nAvailable people:\n${JSON.stringify(memberSummary(members))}\n\nParent main:\n${JSON.stringify(parentMain||{})}\n\nParent subtask:\n${JSON.stringify(parentSub||{})}\n\nCurrent item:\n${JSON.stringify(item||{})}`,
      schema
    });
    return { item:normalizeRegeneratedBlueprintItem(level,result,members,item), provider:`${provider.providerName()}:${config.externalAi.model}`, fallback:false };
  } catch (error) {
    console.error('External AI item regeneration failed; using normalized current item:', error.message);
    return { item:fallback, provider:'local_javascript_engine', fallback:true, warning:error.message };
  }
}

const planSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          phase: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          owner_id: { type: ['integer', 'null'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          acceptance_criteria: { type: 'string' },
          due_date: { type: ['string', 'null'] },
          depends_on_proposal_indexes: { type: 'array', items: { type: 'integer' } }
        },
        required: ['phase', 'title', 'description', 'owner_id', 'priority', 'acceptance_criteria', 'due_date', 'depends_on_proposal_indexes']
      }
    }
  },
  required: ['tasks']
};

async function generatePlan(project, members, brief = '') {
  if (!provider.enabled()) return { items: proposePlan(project, members, brief), provider: 'local_javascript_engine', fallback: true };
  const allowedOwners = new Set(memberSummary(members).map(member => member.user_id));
  try {
    const result = await provider.generateJson({
      system: 'You are a senior project delivery planner. Build a practical, project-specific work breakdown from the supplied facts. Never invent named people, approvals, completed work, or requirements that are not present. Tasks are proposals and must be reviewable by a human.',
      prompt: `Create 6 to 14 sequenced tasks for this project. Make titles concrete, descriptions actionable, and acceptance criteria measurable. Use only owner_id values from the provided members, or null. Dependency indexes are zero-based indexes into the returned tasks array and must only point backward. Use YYYY-MM-DD for a due date only when the supplied project information provides enough schedule information; otherwise use null.\n\nProject:\n${JSON.stringify(projectContext(project, { brief: clean(brief) }))}\n\nMembers:\n${JSON.stringify(memberSummary(members))}`,
      schema: planSchema
    });
    const items = (Array.isArray(result.tasks) ? result.tasks : []).slice(0, 14).map((task, index) => ({
      phase: clean(task.phase).slice(0, 120) || 'Planning',
      title: clean(task.title).slice(0, 220) || `Project task ${index + 1}`,
      description: clean(task.description).slice(0, 10000),
      owner_id: allowedOwners.has(Number(task.owner_id)) ? Number(task.owner_id) : null,
      priority: ['low', 'medium', 'high', 'critical'].includes(task.priority) ? task.priority : 'medium',
      status: 'not_started',
      progress: 0,
      acceptance_criteria: clean(task.acceptance_criteria).slice(0, 10000),
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(clean(task.due_date)) ? clean(task.due_date) : null,
      depends_on_proposal_indexes: [...new Set((Array.isArray(task.depends_on_proposal_indexes) ? task.depends_on_proposal_indexes : [])
        .map(Number).filter(dep => Number.isInteger(dep) && dep >= 0 && dep < index))]
    })).filter(task => task.title);
    if (items.length < 3) throw new Error('AI returned too few usable tasks');
    return { items, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI plan generation failed; using local fallback:', error.message);
    return { items: proposePlan(project, members, brief), provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

const suggestionSchema = {
  type: 'object',
  properties: {
    suggestion: { type: 'string' },
    rationale: { type: 'string' }
  },
  required: ['suggestion', 'rationale']
};

function localFieldSuggestion({ fieldName, value, formContext = {} }) {
  const current = clean(value);
  const field = clean(fieldName).toLowerCase();
  const nearby = Object.entries(formContext || {}).filter(([, v]) => clean(v)).map(([k, v]) => `${k}: ${clean(v)}`).join('; ');
  if (field.includes('objective')) return `Deliver a clear, measurable outcome for ${clean(formContext.name) || 'the project'}, with agreed scope, owners, quality checks, and completion criteria.`;
  if (field.includes('scope')) return current || `Define the included deliverables, user-facing outcomes, integrations, quality requirements, and explicit out-of-scope items${nearby ? ` based on ${nearby}` : ''}.`;
  if (field.includes('acceptance')) return current || 'The expected outcome is completed, reviewed, testable, and supported by recorded evidence with no unresolved critical issues.';
  if (field.includes('description')) return current ? `${current}\n\nClarify the expected outcome, owner, dependencies, constraints, and verification evidence before completion.` : `Describe the requested work, expected outcome, dependencies, constraints, and how completion will be verified${nearby ? `. Context: ${nearby}` : '.'}`;
  if (field.includes('meeting')) return current || 'Summarize decisions, action items with owners, blockers, risks, deadlines, and unresolved questions from the meeting.';
  if (field.includes('message') || field === 'body') return current ? `${current}\n\nPlease confirm the owner, deadline, and next step.` : 'Share the update with the key context, current status, blocker (if any), owner, and next action.';
  if (field.includes('title') || field.includes('name')) return current || 'Clear action-oriented title';
  return current || `Add concise, specific information for ${clean(fieldName) || 'this field'}${nearby ? ` using this context: ${nearby}` : ''}.`;
}

async function suggestField({ fieldName, fieldLabel, value, formContext = {}, project = null, userInstruction = '' }) {
  if (!provider.enabled()) {
    return { suggestion: localFieldSuggestion({ fieldName: fieldLabel || fieldName, value, formContext }), rationale: 'Local smart suggestion. Connect an external AI key for fully generative suggestions.', provider: 'local_javascript_engine', fallback: true };
  }
  try {
    const result = await provider.generateJson({
      system: 'You are an inline writing assistant inside a project-management application. Improve or draft only the requested field. Preserve user intent, do not invent facts, and make the text ready to paste into the field.',
      prompt: `Field name: ${clean(fieldName)}\nField label: ${clean(fieldLabel)}\nCurrent value: ${clean(value)}\nOptional user instruction: ${clean(userInstruction)}\nOther fields in the same form: ${JSON.stringify(formContext || {})}\nCurrent project context: ${JSON.stringify(project || {})}\n\nReturn one strong suggestion. Keep short fields concise and textareas appropriately detailed.`,
      schema: suggestionSchema
    });
    return {
      suggestion: clean(result.suggestion).slice(0, 20000),
      rationale: clean(result.rationale).slice(0, 1000),
      provider: `${provider.providerName()}:${config.externalAi.model}`,
      fallback: false
    };
  } catch (error) {
    console.error('External AI field suggestion failed; using local fallback:', error.message);
    return { suggestion: localFieldSuggestion({ fieldName: fieldLabel || fieldName, value, formContext }), rationale: 'External AI was unavailable, so a local fallback suggestion was generated.', provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

const meetingSchema = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          suggestion_type: { type: 'string', enum: ['task', 'decision', 'risk', 'clarification'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          owner_name: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          evidence: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['suggestion_type', 'title', 'detail', 'owner_name', 'priority', 'severity', 'evidence', 'rationale']
      }
    }
  },
  required: ['suggestions']
};

async function generateMeetingSuggestions(notes, members, project = null) {
  if (!provider.enabled()) return { items: parseMeetingNotes(notes, members), provider: 'local_javascript_engine', fallback: true };
  try {
    const result = await provider.generateJson({
      system: 'You convert meeting notes into review-ready project proposals. Use only explicit or strongly supported information from the notes. Evidence must quote or closely point to the relevant note content. If ownership is unclear, leave owner_name empty. Never invent decisions or completion claims.',
      prompt: `Project context: ${JSON.stringify(project || {})}\nKnown members: ${JSON.stringify(memberSummary(members))}\nMeeting notes:\n${notes}`,
      schema: meetingSchema
    });
    const items = (result.suggestions || []).slice(0, 30).map(item => {
      const type = ['task', 'decision', 'risk', 'clarification'].includes(item.suggestion_type) ? item.suggestion_type : 'clarification';
      if (type === 'task') return { suggestion_type: 'task', payload: { phase: 'Meeting Follow-up', title: clean(item.title).slice(0, 120), description: clean(item.detail), owner_name: clean(item.owner_name), priority: ['low','medium','high','critical'].includes(item.priority) ? item.priority : 'medium', acceptance_criteria: `The follow-up is completed and evidence is recorded: ${clean(item.detail).slice(0, 500)}` }, rationale: clean(item.rationale), evidence: clean(item.evidence) };
      if (type === 'decision') return { suggestion_type: 'decision', payload: { title: clean(item.title).slice(0, 120), detail: clean(item.detail), owner: clean(item.owner_name) }, rationale: clean(item.rationale), evidence: clean(item.evidence) };
      if (type === 'risk') return { suggestion_type: 'risk', payload: { risk_type: 'meeting_note', severity: ['low','medium','high','critical'].includes(item.severity) ? item.severity : 'medium', title: clean(item.title).slice(0, 120), description: clean(item.detail) }, rationale: clean(item.rationale), evidence: clean(item.evidence) };
      return { suggestion_type: 'clarification', payload: { question: clean(item.detail) || clean(item.title) }, rationale: clean(item.rationale), evidence: clean(item.evidence) };
    }).filter(item => item.evidence || item.payload?.question);
    if (!items.length) throw new Error('AI returned no usable meeting suggestions');
    return { items, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI meeting analysis failed; using local fallback:', error.message);
    return { items: parseMeetingNotes(notes, members), provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

const changeSchema = {
  type: 'object',
  properties: {
    impact_scope: { type: 'string' },
    impact_effort: { type: 'string' },
    impact_dependencies: { type: 'string' },
    impact_workload: { type: 'string' }
  },
  required: ['impact_scope', 'impact_effort', 'impact_dependencies', 'impact_workload']
};

async function analyzeChangeWithAi(description, taskCount, activeOwnerCounts, project = null, tasks = []) {
  if (!provider.enabled()) return { item: analyzeChange(description, taskCount, activeOwnerCounts), provider: 'local_javascript_engine', fallback: true };
  try {
    const result = await provider.generateJson({
      system: 'You are a project change-impact analyst. Analyze only the supplied project facts. Distinguish facts from likely effects and do not claim precise effort or dates without evidence.',
      prompt: `Change request: ${description}\nProject: ${JSON.stringify(project || {})}\nExisting task count: ${taskCount}\nActive owner workload counts: ${JSON.stringify(activeOwnerCounts)}\nExisting tasks: ${JSON.stringify((tasks || []).slice(0, 80).map(t => ({ id:t.id,title:t.title,status:t.status,priority:t.priority,owner_id:t.owner_id,phase:t.phase })))}`,
      schema: changeSchema
    });
    return { item: { impact_scope: clean(result.impact_scope), impact_effort: clean(result.impact_effort), impact_dependencies: clean(result.impact_dependencies), impact_workload: clean(result.impact_workload) }, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI change analysis failed; using local fallback:', error.message);
    return { item: analyzeChange(description, taskCount, activeOwnerCounts), provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

const taskRegenerationSchema = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    acceptance_criteria: { type: 'string' }
  },
  required: ['description', 'acceptance_criteria']
};

async function regenerateTask(task, project, members) {
  const fallback = {
    description: `Complete '${task.title}' using only approved project records. Record evidence, unresolved questions, and verification results.`,
    acceptance_criteria: task.acceptance_criteria || 'The expected outcome is complete, reviewed, and supported by stored evidence.'
  };
  if (!provider.enabled()) return { item: fallback, provider: 'local_javascript_engine', fallback: true };
  try {
    const result = await provider.generateJson({
      system: 'You improve a project task without changing its approved intent. Produce an actionable description and measurable acceptance criteria. Do not invent project facts.',
      prompt: `Project: ${JSON.stringify(projectContext(project))}\nTask: ${JSON.stringify({ id: task.id, phase: task.phase, title: task.title, description: task.description, priority: task.priority, acceptance_criteria: task.acceptance_criteria })}\nMembers: ${JSON.stringify(memberSummary(members))}`,
      schema: taskRegenerationSchema
    });
    return { item: { description: clean(result.description).slice(0,10000), acceptance_criteria: clean(result.acceptance_criteria).slice(0,10000) }, provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI task regeneration failed; using local fallback:', error.message);
    return { item: fallback, provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}


const riskSchema = {
  type: 'object',
  properties: {
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          risk_type: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          title: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' }
        },
        required: ['risk_type', 'severity', 'title', 'description', 'evidence']
      }
    }
  },
  required: ['risks']
};

async function scanRisksWithAi(tasks, members, dependencies, project = null) {
  const deterministic = scanRisks(tasks, members, dependencies);
  if (!provider.enabled()) return { items: deterministic, provider: 'local_javascript_engine', fallback: true };
  try {
    const result = await provider.generateJson({
      system: 'You are a cautious project risk analyst. Identify only risks supported by stored data. Evidence must reference concrete task IDs, statuses, due dates, ownership, dependencies, or explicit project constraints. Do not invent market, security, staffing, or schedule facts.',
      prompt: `Project: ${JSON.stringify(project || {})}\nMembers: ${JSON.stringify(memberSummary(members))}\nTasks: ${JSON.stringify((tasks || []).slice(0,120).map(t => ({id:t.id,phase:t.phase,title:t.title,owner_id:t.owner_id,priority:t.priority,status:t.status,progress:t.progress,acceptance_criteria:t.acceptance_criteria,due_date:t.due_date})))}\nDependencies: ${JSON.stringify((dependencies || []).slice(0,240))}\n\nReturn the most material evidence-backed risks only.`,
      schema: riskSchema
    });
    const aiItems = (result.risks || []).slice(0, 25).map(item => ({
      risk_type: clean(item.risk_type).slice(0,80) || 'ai_analysis',
      severity: ['low','medium','high','critical'].includes(item.severity) ? item.severity : 'medium',
      title: clean(item.title).slice(0,220),
      description: clean(item.description).slice(0,10000),
      evidence: clean(item.evidence).slice(0,5000)
    })).filter(item => item.title && item.evidence);
    const combined = [...deterministic];
    const seen = new Set(combined.map(item => `${item.risk_type}|${item.title}`.toLowerCase()));
    for (const item of aiItems) {
      const key = `${item.risk_type}|${item.title}`.toLowerCase();
      if (!seen.has(key)) { seen.add(key); combined.push(item); }
    }
    return { items: combined.slice(0, 40), provider: `${provider.providerName()}:${config.externalAi.model}`, fallback: false };
  } catch (error) {
    console.error('External AI risk scan failed; using local fallback:', error.message);
    return { items: deterministic, provider: 'local_javascript_engine', fallback: true, warning: error.message };
  }
}

module.exports = {
  proposePlan, parseMeetingNotes, analyzeChange, scanRisks, externalModelEnabled, aiStatus,
  generatePlan, generateProjectBlueprint, regenerateProjectBlueprintItem, suggestField, generateMeetingSuggestions, analyzeChangeWithAi, regenerateTask, scanRisksWithAi,
  conciseProjectName
};
