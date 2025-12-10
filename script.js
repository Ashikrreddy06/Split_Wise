/* 
  Simple Splitwise-like app
  - Pure HTML/CSS/JS
  - SPA-style navigation
  - Data persisted to localStorage
  - Supports people, groups, expenses, balances, settlements, backup/import
*/

/* ====== App State & Storage ====== */

// Single global app object to avoid scattered globals
const App = {
  dataKey: "splitit_app_state_v1",
  state: {
    people: [], // {id, name, contact, notes, isYou}
    groups: [], // {id, name, description, memberIds:[]}
    expenses: [], // {id, description, amount, date, payerId, participantSplits:[{personId, amount}], groupId, category, notes, type, createdAt}
    settings: {
      currencySymbol: "₹",
      theme: "light",
    },
  },
  editingPersonId: null,
  editingGroupId: null,
  editingExpenseId: null,
  pendingConfirm: null, // holds callbacks for modal
};

/** Generate a unique-ish id */
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Load state from localStorage or initialize defaults */
function loadState() {
  try {
    const raw = localStorage.getItem(App.dataKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Basic defensive defaulting
      App.state.people = parsed.people || [];
      App.state.groups = parsed.groups || [];
      App.state.expenses = parsed.expenses || [];
      App.state.settings = Object.assign(
        { currencySymbol: "₹", theme: "light" },
        parsed.settings || {}
      );
    }
  } catch (err) {
    console.error("Failed to load state:", err);
  }
}

/** Save state to localStorage */
function saveState() {
  try {
    localStorage.setItem(App.dataKey, JSON.stringify(App.state));
  } catch (err) {
    console.error("Failed to save state:", err);
  }
}

/* ====== Helpers: DOM ====== */

function $(selector) {
  return document.querySelector(selector);
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/* Toast for small notifications */
let toastTimeout;
function showToast(msg) {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
  }, 2200);
}

/* Simple confirmation modal */
function showConfirm(message, onOk) {
  const modal = $("#confirm-modal");
  $("#confirm-message").textContent = message;
  App.pendingConfirm = onOk;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function hideConfirm() {
  const modal = $("#confirm-modal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  App.pendingConfirm = null;
}

/* ====== Currency & formatting ====== */

function getCurrency() {
  return App.state.settings.currencySymbol || "₹";
}

function fmtAmount(num) {
  const n = Number(num) || 0;
  return `${getCurrency()}${n.toFixed(2)}`;
}

/* ====== Balances & Simplified Debts ====== */

/**
 * Calculate net balances per person.
 * - Positive => this person should receive money (others owe them).
 * - Negative => this person owes money.
 *
 * Normal expense:
 *   - Payer lends money to participants.
 *   - For each participantSplit:
 *       balances[participant] -= amount;
 *       balances[payer] += amount;
 *
 * Settlement expense (type === "settlement"):
 *   - Direct transfer from payer to participant,
 *     which reduces their previous debts.
 *   - For each split:
 *       balances[payer] -= amount;
 *       balances[participant] += amount;
 */
function calculateNetBalances() {
  const balances = {};
  App.state.people.forEach((p) => (balances[p.id] = 0));

  for (const exp of App.state.expenses) {
    const { payerId, participantSplits, amount, type } = exp;
    if (!payerId || !participantSplits || !participantSplits.length) continue;

    if (type === "settlement") {
      // Transfer: payer gives money to participant
      for (const ps of participantSplits) {
        balances[payerId] -= ps.amount;
        if (balances[ps.personId] == null) balances[ps.personId] = 0;
        balances[ps.personId] += ps.amount;
      }
    } else {
      // Normal expense
      for (const ps of participantSplits) {
        if (balances[ps.personId] == null) balances[ps.personId] = 0;
        balances[ps.personId] -= ps.amount;
        if (balances[payerId] == null) balances[payerId] = 0;
        balances[payerId] += ps.amount;
      }
    }
  }

  return balances;
}

/**
 * Simplify debts:
 *  Input: netBalances map {personId: balance}
 *  Output: array of settlements [{fromId, toId, amount}]
 *
 *  Greedy algorithm:
 *    - Build list of creditors (balance > 0) and debtors (balance < 0).
 *    - Sort each list by absolute balance descending.
 *    - While both lists non-empty:
 *        - Match biggest debtor with biggest creditor
 *        - Settlement amount = min(debtorOwes, creditorIsOwed)
 *        - Reduce both and move pointers.
 */
function calculateSimplifiedDebts(netBalances) {
  const creditors = [];
  const debtors = [];

  for (const [personId, balance] of Object.entries(netBalances)) {
    if (balance > 0.01) {
      creditors.push({ id: personId, amount: balance });
    } else if (balance < -0.01) {
      debtors.push({ id: personId, amount: -balance });
    }
  }

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const settlements = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const pay = Math.min(debtor.amount, creditor.amount);

    if (pay > 0.01) {
      settlements.push({
        fromId: debtor.id,
        toId: creditor.id,
        amount: pay,
      });

      debtor.amount -= pay;
      creditor.amount -= pay;

      if (debtor.amount <= 0.01) i++;
      if (creditor.amount <= 0.01) j++;
    } else {
      break;
    }
  }

  return settlements;
}

/* ====== Rendering: Dashboard ====== */

function renderDashboard() {
  const balances = calculateNetBalances();
  const youPerson = App.state.people.find((p) => p.isYou);
  let youOwe = 0;
  let youAreOwed = 0;

  if (youPerson) {
    const b = balances[youPerson.id] || 0;
    if (b > 0) youAreOwed = b;
    if (b < 0) youOwe = -b;
  }

  $("#you-are-owed").textContent = fmtAmount(youAreOwed);
  $("#you-owe").textContent = fmtAmount(youOwe);

  // Per-person list
  const container = $("#person-balances");
  container.innerHTML = "";
  const entries = Object.entries(balances).filter(
    ([, bal]) => Math.abs(bal) > 0.01
  );

  if (!entries.length) {
    container.classList.add("empty-state");
    container.textContent = "No net balances. Everyone is settled!";
    return;
  } else {
    container.classList.remove("empty-state");
  }

  for (const [personId, bal] of entries) {
    const person = App.state.people.find((p) => p.id === personId);
    if (!person) continue;

    const card = createEl(
      "div",
      "person-balance-card " + (bal < 0 ? "owes" : "is-owed")
    );
    const name = createEl("div", "name", person.name);
    const status = createEl("div", "status");

    if (bal > 0) {
      status.textContent = `Others owe ${person.name} ${fmtAmount(bal)}`;
    } else {
      status.textContent = `${person.name} owes others ${fmtAmount(-bal)}`;
    }

    card.appendChild(name);
    card.appendChild(status);
    container.appendChild(card);
  }

  // Suggested settlements
  renderSuggestedSettlements();
}

/* Render suggested settlements in Dashboard */
function renderSuggestedSettlements() {
  const cont = $("#settlements-list");
  cont.innerHTML = "";
  const balances = calculateNetBalances();
  const settlements = calculateSimplifiedDebts(balances);

  if (!settlements.length) {
    cont.classList.add("empty-state");
    cont.textContent = "Everyone is settled. 🎉";
    return;
  } else {
    cont.classList.remove("empty-state");
  }

  settlements.forEach((s) => {
    const from = App.state.people.find((p) => p.id === s.fromId);
    const to = App.state.people.find((p) => p.id === s.toId);
    if (!from || !to) return;

    const item = createEl("div", "settlement-item");
    item.appendChild(
      createEl(
        "div",
        "",
        `${from.name} should pay ${to.name} ${fmtAmount(s.amount)}`
      )
    );
    const btn = createEl("button", "primary-btn small-btn", "Settle Up");
    btn.addEventListener("click", () => {
      handleSettleUpClick(from.id, to.id, s.amount);
    });
    item.appendChild(btn);
    cont.appendChild(item);
  });
}

/* ====== People ====== */

function renderPeopleList() {
  const list = $("#people-list");
  list.innerHTML = "";

  if (!App.state.people.length) {
    list.classList.add("empty-state");
    list.textContent = "No people added yet.";
    return;
  }
  list.classList.remove("empty-state");

  App.state.people.forEach((person) => {
    const row = createEl("div", "person-balance-card");
    const left = createEl("div", "name", person.name);
    const right = createEl("div", "status");

    let subtitle = [];
    if (person.contact) subtitle.push(person.contact);
    if (person.isYou) subtitle.push("This is you");
    if (person.notes) subtitle.push(person.notes);
    right.textContent = subtitle.join(" • ");

    const actions = createEl("div", "expense-actions");
    const editBtn = createEl("button", "secondary-btn small-btn", "Edit");
    const delBtn = createEl("button", "danger-btn small-btn", "Delete");

    editBtn.addEventListener("click", () => {
      App.editingPersonId = person.id;
      $("#people-form-title").textContent = "Edit Person";
      $("#person-id").value = person.id;
      $("#person-name").value = person.name;
      $("#person-contact").value = person.contact || "";
      $("#person-notes").value = person.notes || "";
      $("#person-is-you").checked = !!person.isYou;
    });

    delBtn.addEventListener("click", () => {
      showConfirm(`Delete ${person.name}?`, () => {
        deletePerson(person.id);
      });
    });

    actions.append(editBtn, delBtn);
    row.append(left, right, actions);
    list.appendChild(row);
  });

  // Also update participants checkboxes in groups & expenses, and filters
  renderGroupMembersOptions();
  renderExpenseParticipantsOptions();
  renderPayerOptions();
  renderFiltersPeopleOptions();
  renderDashboard();
  renderGroupBalances();
}

/** Add or update person */
function upsertPersonFromForm(event) {
  event.preventDefault();
  const id = $("#person-id").value || null;
  const name = $("#person-name").value.trim();
  const contact = $("#person-contact").value.trim();
  const notes = $("#person-notes").value.trim();
  const isYou = $("#person-is-you").checked;

  $("#person-name-error").textContent = "";

  if (!name) {
    $("#person-name-error").textContent = "Name cannot be empty.";
    return;
  }

  // Ensure only one person is marked "you"
  if (isYou) {
    App.state.people.forEach((p) => (p.isYou = false));
  }

  if (id) {
    const p = App.state.people.find((x) => x.id === id);
    if (p) {
      p.name = name;
      p.contact = contact;
      p.notes = notes;
      p.isYou = isYou;
    }
    showToast("Person updated");
  } else {
    App.state.people.push({
      id: generateId("person"),
      name,
      contact,
      notes,
      isYou,
    });
    showToast("Person added");
  }

  saveState();
  resetPersonForm();
  renderPeopleList();
}

function resetPersonForm() {
  App.editingPersonId = null;
  $("#people-form-title").textContent = "Add Person";
  $("#person-id").value = "";
  $("#person-name").value = "";
  $("#person-contact").value = "";
  $("#person-notes").value = "";
  $("#person-is-you").checked = false;
  $("#person-name-error").textContent = "";
}

function deletePerson(id) {
  // Basic prevention: if they appear in expenses/groups, deleting them is allowed
  // but might make older entries refer to unknown person; we'll keep the id
  // around in expenses and just show "(Deleted)" later if needed.
  App.state.people = App.state.people.filter((p) => p.id !== id);
  App.state.groups.forEach((g) => {
    g.memberIds = g.memberIds.filter((mid) => mid !== id);
  });

  saveState();
  hideConfirm();
  renderPeopleList();
  renderExpensesList();
  renderDashboard();
}

/* ====== Groups ====== */

function renderGroupMembersOptions() {
  const container = $("#group-members");
  container.innerHTML = "";

  if (!App.state.people.length) {
    container.textContent = "Add people first.";
    container.classList.add("empty-state");
    return;
  }
  container.classList.remove("empty-state");

  App.state.people.forEach((p) => {
    const label = createEl("label", "chip");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = p.id;
    label.appendChild(input);
    label.appendChild(createEl("span", "", p.name));
    container.appendChild(label);
  });
}

function renderGroupsList() {
  const list = $("#groups-list");
  list.innerHTML = "";

  if (!App.state.groups.length) {
    list.classList.add("empty-state");
    list.textContent = "No groups yet.";
    return;
  }
  list.classList.remove("empty-state");

  App.state.groups.forEach((g) => {
    const row = createEl("div", "person-balance-card");
    const name = createEl("div", "name", g.name);
    const members = g.memberIds
      .map((id) => App.state.people.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => p.name)
      .join(", ");
    const status = createEl(
      "div",
      "status",
      `${g.description || "No description"} • Members: ${
        members || "none yet"
      }`
    );

    const actions = createEl("div", "expense-actions");
    const editBtn = createEl("button", "secondary-btn small-btn", "Edit");
    const delBtn = createEl("button", "danger-btn small-btn", "Delete");

    editBtn.addEventListener("click", () => {
      App.editingGroupId = g.id;
      $("#groups-form-title").textContent = "Edit Group";
      $("#group-id").value = g.id;
      $("#group-name").value = g.name;
      $("#group-description").value = g.description || "";

      // Set checkboxes
      document
        .querySelectorAll("#group-members input[type=checkbox]")
        .forEach((cb) => {
          cb.checked = g.memberIds.includes(cb.value);
        });
    });

    delBtn.addEventListener("click", () => {
      showConfirm(`Delete group "${g.name}"?`, () => {
        deleteGroup(g.id);
      });
    });

    actions.append(editBtn, delBtn);
    row.append(name, status, actions);
    list.appendChild(row);
  });

  renderGroupSelects();
  renderGroupBalances();
}

/** Add or update group from form */
function upsertGroupFromForm(e) {
  e.preventDefault();
  const id = $("#group-id").value || null;
  const name = $("#group-name").value.trim();
  const description = $("#group-description").value.trim();

  const memberIds = Array.from(
    document.querySelectorAll("#group-members input[type=checkbox]:checked")
  ).map((cb) => cb.value);

  $("#group-name-error").textContent = "";
  if (!name) {
    $("#group-name-error").textContent = "Group name cannot be empty.";
    return;
  }

  const groupData = { name, description, memberIds };

  if (id) {
    const g = App.state.groups.find((x) => x.id === id);
    if (g) {
      Object.assign(g, groupData);
    }
    showToast("Group updated");
  } else {
    App.state.groups.push({
      id: generateId("group"),
      ...groupData,
    });
    showToast("Group added");
  }

  saveState();
  resetGroupForm();
  renderGroupsList();
}

function resetGroupForm() {
  App.editingGroupId = null;
  $("#groups-form-title").textContent = "Add Group";
  $("#group-id").value = "";
  $("#group-name").value = "";
  $("#group-description").value = "";
  $("#group-name-error").textContent = "";
  document
    .querySelectorAll("#group-members input[type=checkbox]")
    .forEach((cb) => (cb.checked = false));
}

function deleteGroup(id) {
  App.state.groups = App.state.groups.filter((g) => g.id !== id);
  App.state.expenses.forEach((exp) => {
    if (exp.groupId === id) exp.groupId = "";
  });
  saveState();
  hideConfirm();
  renderGroupsList();
  renderExpensesList();
}

/* Group balances: show per group summary using only that group's expenses */
function renderGroupBalances() {
  const cont = $("#group-balances");
  cont.innerHTML = "";

  if (!App.state.groups.length) {
    cont.classList.add("empty-state");
    cont.textContent =
      "Create groups and add expenses to see group balances here.";
    return;
  }
  cont.classList.remove("empty-state");

  App.state.groups.forEach((g) => {
    const groupExpenses = App.state.expenses.filter(
      (exp) => exp.groupId === g.id
    );
    if (!groupExpenses.length) return;

    // Calculate balances within group only
    const balances = {};
    g.memberIds.forEach((id) => (balances[id] = 0));

    for (const exp of groupExpenses) {
      const { payerId, participantSplits, type } = exp;
      if (!payerId || !participantSplits) continue;

      if (type === "settlement") {
        for (const ps of participantSplits) {
          balances[payerId] -= ps.amount;
          if (balances[ps.personId] == null) balances[ps.personId] = 0;
          balances[ps.personId] += ps.amount;
        }
      } else {
        for (const ps of participantSplits) {
          if (balances[ps.personId] == null) balances[ps.personId] = 0;
          balances[ps.personId] -= ps.amount;
          if (balances[payerId] == null) balances[payerId] = 0;
          balances[payerId] += ps.amount;
        }
      }
    }

    const wrapper = createEl("div", "card soft-card");
    const title = createEl("h3", "", g.name);
    wrapper.appendChild(title);

    const entries = Object.entries(balances).filter(
      ([, bal]) => Math.abs(bal) > 0.01
    );
    if (!entries.length) {
      wrapper.appendChild(
        createEl("div", "hint", "Everyone is settled in this group.")
      );
    } else {
      entries.forEach(([pid, bal]) => {
        const person = App.state.people.find((p) => p.id === pid);
        if (!person) return;
        const row = createEl("div", "person-balance-card");
        const left = createEl("div", "name", person.name);
        const right = createEl("div", "status");
        if (bal > 0)
          right.textContent = `Others owe ${person.name} ${fmtAmount(bal)}`;
        else right.textContent = `${person.name} owes ${fmtAmount(-bal)}`;
        row.append(left, right);
        wrapper.appendChild(row);
      });
    }

    cont.appendChild(wrapper);
  });

  if (!cont.children.length) {
    cont.classList.add("empty-state");
    cont.textContent = "No balances yet.";
  }
}

/* ====== Expenses ====== */

function renderPayerOptions() {
  const sel = $("#expense-payer");
  sel.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = "Select payer";
  sel.appendChild(opt);

  App.state.people.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });
}

function renderGroupSelects() {
  const expGroup = $("#expense-group");
  const filterGroup = $("#filter-group");
  expGroup.innerHTML = "";
  filterGroup.innerHTML = "";

  const noGroup = document.createElement("option");
  noGroup.value = "";
  noGroup.textContent = "No group";
  expGroup.appendChild(noGroup);

  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All";
  filterGroup.appendChild(allOpt);

  App.state.groups.forEach((g) => {
    const o1 = document.createElement("option");
    o1.value = g.id;
    o1.textContent = g.name;
    expGroup.appendChild(o1);

    const o2 = document.createElement("option");
    o2.value = g.id;
    o2.textContent = g.name;
    filterGroup.appendChild(o2);
  });
}

function renderExpenseParticipantsOptions() {
  const cont = $("#expense-participants");
  cont.innerHTML = "";

  if (!App.state.people.length) {
    cont.textContent = "Add people first.";
    cont.classList.add("empty-state");
    return;
  }
  cont.classList.remove("empty-state");

  App.state.people.forEach((p) => {
    const label = createEl("label", "chip");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = p.id;
    input.addEventListener("change", renderSplitInputs);
    label.appendChild(input);
    label.appendChild(createEl("span", "", p.name));
    cont.appendChild(label);
  });

  renderSplitInputs();
}

/* Render per-person split inputs depending on mode */
function renderSplitInputs() {
  const splitCont = $("#split-inputs");
  splitCont.innerHTML = "";

  const selectedParticipants = getSelectedParticipantIds();
  const splitType = getSelectedSplitType();

  if (!selectedParticipants.length) {
    splitCont.appendChild(
      createEl("div", "hint", "Select participants to configure the split.")
    );
    return;
  }

  if (splitType === "equal") {
    splitCont.appendChild(
      createEl(
        "div",
        "hint",
        `The amount will be split equally among ${selectedParticipants.length} participant(s).`
      )
    );
    return;
  }

  // For exact, percent, shares – show input per participant
  selectedParticipants.forEach((id) => {
    const person = App.state.people.find((p) => p.id === id);
    const item = createEl("div", "split-item");
    const label = createEl("label", "");
    const nameSpan = createEl("span", "", person ? person.name : "Unknown");

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.01";

    if (splitType === "exact") {
      input.placeholder = "Amount";
      input.name = `split-amount-${id}`;
    } else if (splitType === "percent") {
      input.placeholder = "%";
      input.name = `split-percent-${id}`;
    } else {
      input.placeholder = "Shares";
      input.name = `split-shares-${id}`;
      input.step = "1";
      input.min = "0";
    }

    label.append(nameSpan, input);
    item.appendChild(label);
    splitCont.appendChild(item);
  });

  // Hint
  const hint = createEl("div", "hint");
  if (splitType === "exact") {
    hint.textContent = "Total of all amounts should match the expense amount.";
  } else if (splitType === "percent") {
    hint.textContent = "Total percentage should be 100%.";
  } else {
    hint.textContent =
      "Each share is a weight. Example: A=2 shares, B=1 share → A pays 2/3.";
  }
  splitCont.appendChild(hint);
}

function getSelectedParticipantIds() {
  return Array.from(
    document.querySelectorAll(
      "#expense-participants input[type=checkbox]:checked"
    )
  ).map((cb) => cb.value);
}

function getSelectedSplitType() {
  const checked = document.querySelector(
    "input[name=split-type]:checked"
  );
  return checked ? checked.value : "equal";
}

/* Add or update expense */
function upsertExpenseFromForm(e) {
  e.preventDefault();
  $("#expense-form-error").textContent = "";
  $("#expense-participants-error").textContent = "";
  $("#expense-split-error").textContent = "";

  const id = $("#expense-id").value || null;
  const description = $("#expense-description").value.trim();
  const amount = parseFloat($("#expense-amount").value);
  const date = $("#expense-date").value;
  const payerId = $("#expense-payer").value;
  const groupId = $("#expense-group").value || "";
  const category = $("#expense-category").value || "Other";
  const notes = $("#expense-notes").value.trim();
  const splitType = getSelectedSplitType();
  const participantIds = getSelectedParticipantIds();

  if (!description) {
    $("#expense-form-error").textContent = "Description cannot be empty.";
    return;
  }
  if (!(amount > 0)) {
    $("#expense-form-error").textContent = "Amount must be greater than 0.";
    return;
  }
  if (!date) {
    $("#expense-form-error").textContent = "Please choose a date.";
    return;
  }
  if (!payerId) {
    $("#expense-form-error").textContent = "Please select a payer.";
    return;
  }
  if (!participantIds.length) {
    $("#expense-participants-error").textContent =
      "Select at least one participant.";
    return;
  }

  const splits = computeSplits(amount, participantIds, splitType);
  if (!splits.ok) {
    $("#expense-split-error").textContent = splits.error;
    return;
  }

  const expenseData = {
    description,
    amount,
    date,
    payerId,
    participantSplits: splits.splits,
    groupId,
    category,
    notes,
    type: "expense",
    createdAt: id
      ? (App.state.expenses.find((x) => x.id === id) || {}).createdAt
      : new Date().toISOString(),
  };

  if (id) {
    const existing = App.state.expenses.find((x) => x.id === id);
    if (existing) {
      Object.assign(existing, expenseData);
    }
    showToast("Expense updated");
  } else {
    App.state.expenses.push({
      id: generateId("expense"),
      ...expenseData,
    });
    showToast("Expense added");
  }

  saveState();
  resetExpenseForm();
  renderExpensesList();
  renderDashboard();
  renderGroupBalances();
}

/**
 * Compute participant splits based on type.
 * Returns {ok: boolean, error?:string, splits?:[{personId, amount}]}
 */
function computeSplits(totalAmount, participantIds, splitType) {
  const splits = [];

  if (splitType === "equal") {
    const n = participantIds.length;
    const basic = Math.floor((totalAmount / n) * 100) / 100;
    let remaining = totalAmount - basic * n;

    participantIds.forEach((pid, idx) => {
      let amt = basic;
      if (idx === 0) amt += remaining; // put leftover in first participant
      splits.push({ personId: pid, amount: parseFloat(amt.toFixed(2)) });
    });

    return { ok: true, splits };
  }

  if (splitType === "exact") {
    let sum = 0;
    for (const pid of participantIds) {
      const val = parseFloat(
        document.querySelector(`input[name="split-amount-${pid}"]`)?.value ||
          "0"
      );
      if (val < 0) {
        return { ok: false, error: "Split amounts cannot be negative." };
      }
      sum += val;
      splits.push({ personId: pid, amount: val });
    }
    if (Math.abs(sum - totalAmount) > 0.01) {
      return {
        ok: false,
        error:
          "Sum of amounts must equal total. Currently: " +
          fmtAmount(sum) +
          " (vs " +
          fmtAmount(totalAmount) +
          ")",
      };
    }
    return { ok: true, splits };
  }

  if (splitType === "percent") {
    let totalPercent = 0;
    const percents = [];
    for (const pid of participantIds) {
      const val = parseFloat(
        document.querySelector(`input[name="split-percent-${pid}"]`)?.value ||
          "0"
      );
      if (val < 0) {
        return { ok: false, error: "Percentages cannot be negative." };
      }
      totalPercent += val;
      percents.push({ pid, percent: val });
    }
    if (Math.abs(totalPercent - 100) > 0.5) {
      return {
        ok: false,
        error:
          "Total percentage must be ~100%. Currently: " +
          totalPercent.toFixed(2) +
          "%",
      };
    }

    let sum = 0;
    percents.forEach((p, idx) => {
      let amt = (totalAmount * p.percent) / totalPercent;
      if (idx === percents.length - 1) {
        amt = totalAmount - sum; // ensure totals align exactly
      }
      amt = parseFloat(amt.toFixed(2));
      sum += amt;
      splits.push({ personId: p.pid, amount: amt });
    });
    return { ok: true, splits };
  }

  if (splitType === "shares") {
    let totalShares = 0;
    const shares = [];
    for (const pid of participantIds) {
      const raw = document.querySelector(
        `input[name="split-shares-${pid}"]`
      )?.value;
      const val = parseFloat(raw || "0");
      if (val < 0) {
        return { ok: false, error: "Shares cannot be negative." };
      }
      totalShares += val;
      shares.push({ pid, shares: val });
    }
    if (totalShares <= 0) {
      return { ok: false, error: "Total shares must be greater than 0." };
    }

    let sum = 0;
    shares.forEach((s, idx) => {
      let amt = (totalAmount * s.shares) / totalShares;
      if (idx === shares.length - 1) {
        amt = totalAmount - sum;
      }
      amt = parseFloat(amt.toFixed(2));
      sum += amt;
      splits.push({ personId: s.pid, amount: amt });
    });
    return { ok: true, splits };
  }

  return { ok: false, error: "Unknown split type." };
}

function resetExpenseForm() {
  App.editingExpenseId = null;
  $("#expense-form-title").textContent = "Add Expense";
  $("#expense-id").value = "";
  $("#expense-description").value = "";
  $("#expense-amount").value = "";
  $("#expense-date").valueAsDate = new Date();
  $("#expense-payer").value = "";
  $("#expense-group").value = "";
  $("#expense-category").value = "Food";
  $("#expense-notes").value = "";
  document
    .querySelectorAll("#expense-participants input[type=checkbox]")
    .forEach((cb) => (cb.checked = false));
  document.querySelector('input[name="split-type"][value="equal"]').checked =
    true;
  $("#expense-form-error").textContent = "";
  $("#expense-participants-error").textContent = "";
  $("#expense-split-error").textContent = "";
  renderSplitInputs();
}

/* Expenses list & filters */

function renderFiltersPeopleOptions() {
  const sel = $("#filter-person");
  sel.innerHTML = "";
  const o = document.createElement("option");
  o.value = "";
  o.textContent = "All";
  sel.appendChild(o);

  App.state.people.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
}

function renderExpensesList() {
  const list = $("#expenses-list");
  list.innerHTML = "";

  if (!App.state.expenses.length) {
    list.classList.add("empty-state");
    list.textContent = "No expenses yet.";
    return;
  }
  list.classList.remove("empty-state");

  const filtered = getFilteredAndSortedExpenses();

  if (!filtered.length) {
    list.classList.add("empty-state");
    list.textContent = "No expenses match these filters.";
    return;
  }

  // Header row
  const header = createEl("div", "expense-row expense-row-header");
  ["Description", "Amount", "Payer", "Date", "Group", "Category", "Actions"].forEach(
    (h) => header.appendChild(createEl("div", "", h))
  );
  list.appendChild(header);

  filtered.forEach((exp) => {
    const row = createEl("div", "expense-row");
    const payer = App.state.people.find((p) => p.id === exp.payerId);
    const group = App.state.groups.find((g) => g.id === exp.groupId);

    const descCol = createEl("div", "");
    const title = createEl(
      "div",
      "",
      exp.description + (exp.type === "settlement" ? " (Settlement)" : "")
    );
    const meta = createEl("div", "expense-meta");
    const participantsNames = (exp.participantSplits || [])
      .map((ps) => {
        const p = App.state.people.find((pp) => pp.id === ps.personId);
        return p ? p.name : "Unknown";
      })
      .join(", ");
    meta.textContent =
      (exp.category || "Other") +
      " • Split among: " +
      (participantsNames || "N/A");
    descCol.append(title, meta);

    const amtCol = createEl("div", "", fmtAmount(exp.amount));
    const payerCol = createEl("div", "", payer ? payer.name : "Unknown");
    const dateCol = createEl("div", "", exp.date || "");
    const groupCol = createEl("div", "", group ? group.name : "-");
    const catCol = createEl("div", "", exp.category || "");
    const actCol = createEl("div", "expense-actions");

    const editBtn = createEl("button", "secondary-btn small-btn", "Edit");
    editBtn.addEventListener("click", () => {
      loadExpenseIntoForm(exp.id);
    });

    const delBtn = createEl("button", "danger-btn small-btn", "Delete");
    delBtn.addEventListener("click", () => {
      showConfirm(`Delete expense "${exp.description}"?`, () => {
        deleteExpense(exp.id);
      });
    });

    actCol.append(editBtn, delBtn);

    row.append(descCol, amtCol, payerCol, dateCol, groupCol, catCol, actCol);
    list.appendChild(row);
  });
}

function getFilteredAndSortedExpenses() {
  let exps = [...App.state.expenses];

  const groupFilter = $("#filter-group").value;
  const personFilter = $("#filter-person").value;
  const catFilter = $("#filter-category").value;
  const searchFilter = $("#filter-search").value.toLowerCase();
  const dateFrom = $("#filter-date-from").value;
  const dateTo = $("#filter-date-to").value;
  const sortBy = $("#sort-by").value;

  if (groupFilter) {
    exps = exps.filter((exp) => exp.groupId === groupFilter);
  }

  if (personFilter) {
    exps = exps.filter((exp) => {
      if (exp.payerId === personFilter) return true;
      return (exp.participantSplits || []).some(
        (ps) => ps.personId === personFilter
      );
    });
  }

  if (catFilter) {
    exps = exps.filter((exp) => exp.category === catFilter);
  }

  if (searchFilter) {
    exps = exps.filter((exp) =>
      (exp.description || "").toLowerCase().includes(searchFilter)
    );
  }

  if (dateFrom) {
    exps = exps.filter((exp) => (!exp.date || exp.date >= dateFrom));
  }

  if (dateTo) {
    exps = exps.filter((exp) => (!exp.date || exp.date <= dateTo));
  }

  exps.sort((a, b) => {
    if (sortBy === "date-desc") {
      return (b.date || "").localeCompare(a.date || "");
    }
    if (sortBy === "date-asc") {
      return (a.date || "").localeCompare(b.date || "");
    }
    if (sortBy === "amount-desc") {
      return b.amount - a.amount;
    }
    if (sortBy === "amount-asc") {
      return a.amount - b.amount;
    }
    return 0;
  });

  return exps;
}

function loadExpenseIntoForm(id) {
  const exp = App.state.expenses.find((e) => e.id === id);
  if (!exp) return;
  App.editingExpenseId = id;
  $("#expense-form-title").textContent = "Edit Expense";
  $("#expense-id").value = id;
  $("#expense-description").value = exp.description;
  $("#expense-amount").value = exp.amount;
  $("#expense-date").value = exp.date;
  $("#expense-payer").value = exp.payerId || "";
  $("#expense-group").value = exp.groupId || "";
  $("#expense-category").value = exp.category || "Other";
  $("#expense-notes").value = exp.notes || "";

  // participants
  document
    .querySelectorAll("#expense-participants input[type=checkbox]")
    .forEach((cb) => {
      cb.checked = (exp.participantSplits || []).some(
        (ps) => ps.personId === cb.value
      );
    });

  // split type: we cannot perfectly infer, default to equal
  document.querySelector('input[name="split-type"][value="equal"]').checked =
    true;
  renderSplitInputs();
}

function deleteExpense(id) {
  App.state.expenses = App.state.expenses.filter((e) => e.id !== id);
  saveState();
  hideConfirm();
  renderExpensesList();
  renderDashboard();
  renderGroupBalances();
}

/* ====== Settle Up ====== */

/**
 * When user clicks "Settle Up" on a suggested settlement:
 *  - We create a special "settlement" expense that represents a direct transfer
 *    from one person to another.
 */
function handleSettleUpClick(fromId, toId, amount) {
  const from = App.state.people.find((p) => p.id === fromId);
  const to = App.state.people.find((p) => p.id === toId);
  if (!from || !to) return;

  showConfirm(
    `Mark settlement as paid: ${from.name} pays ${to.name} ${fmtAmount(
      amount
    )}?`,
    () => {
      const exp = {
        id: generateId("expense"),
        description: `Settlement: ${from.name} paid ${to.name}`,
        amount,
        date: new Date().toISOString().slice(0, 10),
        payerId: fromId,
        participantSplits: [{ personId: toId, amount }],
        groupId: "",
        category: "Settlement",
        notes: "",
        type: "settlement",
        createdAt: new Date().toISOString(),
      };

      App.state.expenses.push(exp);
      saveState();
      hideConfirm();
      showToast("Settlement recorded");
      renderExpensesList();
      renderDashboard();
      renderGroupBalances();
    }
  );
}

/* ====== Settings, Theme, Backup/Import ====== */

function applyTheme() {
  const theme = App.state.settings.theme || "light";
  if (theme === "dark") {
    document.body.classList.add("dark");
  } else {
    document.body.classList.remove("dark");
  }
}

function initSettingsUI() {
  $("#currency-symbol").value = getCurrency();
}

function handleSettingsSubmit(e) {
  e.preventDefault();
  const sym = $("#currency-symbol").value || "₹";
  App.state.settings.currencySymbol = sym;
  saveState();
  renderDashboard();
  renderExpensesList();
  renderGroupBalances();
  showToast("Settings saved");
}

/* Backup to JSON */
function exportData() {
  const dataStr = JSON.stringify(App.state, null, 2);
  const blob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "splitit_backup.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* Import from JSON backup */
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || typeof parsed !== "object") {
        showToast("Invalid file.");
        return;
      }
      showConfirm("Import data and overwrite current state?", () => {
        App.state = {
          people: parsed.people || [],
          groups: parsed.groups || [],
          expenses: parsed.expenses || [],
          settings: Object.assign(
            { currencySymbol: "₹", theme: "light" },
            parsed.settings || {}
          ),
        };
        saveState();
        hideConfirm();
        applyTheme();
        initSettingsUI();
        renderAll();
        showToast("Data imported");
      });
    } catch (err) {
      console.error(err);
      showToast("Failed to import data.");
    }
  };
  reader.readAsText(file);
}

/* ====== Navigation ====== */

function initNavigation() {
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sectionId = btn.getAttribute("data-section");

      document
        .querySelectorAll(".nav-link")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      document.querySelectorAll(".section").forEach((sec) => {
        sec.classList.remove("active");
      });
      const section = document.getElementById(sectionId);
      if (section) section.classList.add("active");
    });
  });
}

/* ====== Initial Render ====== */

function renderAll() {
  renderPeopleList();
  renderGroupMembersOptions();
  renderGroupsList();
  renderPayerOptions();
  renderExpenseParticipantsOptions();
  renderGroupSelects();
  renderFiltersPeopleOptions();
  renderExpensesList();
  renderDashboard();
}

/* ====== Event Listeners ====== */

function initEventListeners() {
  // Confirm modal buttons
  $("#confirm-cancel").addEventListener("click", hideConfirm);
  $("#confirm-ok").addEventListener("click", () => {
    if (typeof App.pendingConfirm === "function") {
      App.pendingConfirm();
    } else {
      hideConfirm();
    }
  });

  // People form
  $("#person-form").addEventListener("submit", upsertPersonFromForm);
  $("#person-cancel-btn").addEventListener("click", (e) => {
    e.preventDefault();
    resetPersonForm();
  });

  // Group form
  $("#group-form").addEventListener("submit", upsertGroupFromForm);
  $("#group-cancel-btn").addEventListener("click", (e) => {
    e.preventDefault();
    resetGroupForm();
  });

  // Expense form
  $("#expense-form").addEventListener("submit", upsertExpenseFromForm);
  $("#expense-cancel-btn").addEventListener("click", (e) => {
    e.preventDefault();
    resetExpenseForm();
  });

  document
    .querySelectorAll('input[name="split-type"]')
    .forEach((radio) =>
      radio.addEventListener("change", () => {
        renderSplitInputs();
      })
    );

  // Filters
  [
    "#filter-group",
    "#filter-person",
    "#filter-category",
    "#filter-search",
    "#filter-date-from",
    "#filter-date-to",
    "#sort-by",
  ].forEach((sel) => {
    $(sel).addEventListener("input", () => {
      renderExpensesList();
    });
  });

  $("#clear-filters-btn").addEventListener("click", () => {
    $("#filter-group").value = "";
    $("#filter-person").value = "";
    $("#filter-category").value = "";
    $("#filter-search").value = "";
    $("#filter-date-from").value = "";
    $("#filter-date-to").value = "";
    $("#sort-by").value = "date-desc";
    renderExpensesList();
  });

  // Settings
  $("#settings-form").addEventListener("submit", handleSettingsSubmit);
  $("#theme-toggle").addEventListener("click", () => {
    App.state.settings.theme =
      App.state.settings.theme === "dark" ? "light" : "dark";
    saveState();
    applyTheme();
  });

  // Export / Import
  $("#export-btn").addEventListener("click", exportData);
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      importData(file);
      e.target.value = "";
    }
  });

  // Recalculate settlements
  $("#refresh-settlements-btn").addEventListener("click", renderSuggestedSettlements);
}

/* ====== Startup ====== */

document.addEventListener("DOMContentLoaded", () => {
  loadState();
  applyTheme();
  initSettingsUI();
  initNavigation();
  initEventListeners();

  // Default date for expense form
  if ($("#expense-date")) {
    $("#expense-date").valueAsDate = new Date();
  }

  renderAll();
});
