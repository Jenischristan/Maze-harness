# Dream-RSI: Recursive Self-Improvement through Evolving Worlds

> **DREAM_1.md** — Part 1 of the full-paper conversion. Covers **PDF pages 1–10** (10 of 36 pages).
> Source: `Dream-RSI/papers/Dream-RSI.pdf` from https://github.com/zhengkid/Dream-RSI
> Page 10 ends mid-sentence; the text continues on page 11 (not included in this part).
> Figure and chart descriptions are written from the rendered page screenshots. Numeric readings taken from plotted curves are marked *approximate*; values printed in tables and captions are exact.

---

## [Page 1]

*Page chrome: the Google logo sits at the top-left above a thin horizontal rule.*

# Dream-RSI: Recursive Self-Improvement through Evolving Worlds

**Authors:** Tong Zheng¹,², Xidong Wu¹, Zheng Zhang¹, Zhankui He³, Chaoyi Zhang¹, Benjamin Coleman³, Ruoqiao Wei¹, Di Bai³, Haolin Liu⁴, Rui Liu², Xue Wang¹, Yue Zhuan¹, Wang-Cheng Kang³, Renkai Xiang¹, Heng Huang², Xinwu Cheng¹ and Yunsong Guo¹

**Affiliations:** ¹Google, ²University of Maryland, College Park, ³Google Deepmind, ⁴University of Virginia

### Abstract

**Recursive self-improvement is becoming increasingly vital for autonomous AI agents, where progress hinges on discovering high-value solutions across complex domains. The driver of this process is effective exploration, however, managing and improving exploration strategies remains a major bottleneck. Current systems face a fundamental dilemma: fixed strategies fail to adapt as search spaces scale, while online policy optimization requires navigating vast meta-search spaces under delayed and expensive feedback over long-horizon rollouts. We introduce Dream-RSI, a framework for scalable and recursively self-improving exploration. A lightweight orchestration layer makes exploration explicit and programmable while leaving the underlying coding agent unchanged. Our key insight is that accumulated discovery history can serve as a replay simulator over the realized search space. By performing dreaming in the replay simulator constructed from historical discovery trees, Dream-RSI secures immediate, low-cost off-policy feedback to evaluate and refine exploration policies without invoking repetitive, expensive online evaluations. The improved policy is subsequently redeployed online to drive further discovery, continuously expanding the simulator pool in a self-improving loop. Across algorithm engineering, mathematical optimization, and GPU kernel engineering, Dream-RSI achieves competitive or improved discovery quality while substantially reducing discovery cost in several settings.**

*Links row (centered, monospace, with icons):* GitHub icon **github.com/zhengkid/Dream-RSI** | globe icon **dream-rsi.com**

## 1. Introduction

Recursive self-improvement (RSI) has emerged as an ambitious goal for autonomous AI systems (Liu et al., 2026c). A common mechanism underlying RSI is an iterative discovery loop wherein agents generate candidate solutions, evaluate outcomes, incorporate feedback, and refine future iterations. Such discovery loops have driven substantial progress across scientific and algorithmic domains, including algorithm design (Novikov et al., 2025; Romera-Paredes et al., 2024), open-ended mathematical optimization (Anthropic, 2026; Georgiev et al., 2025), systems design (Cao et al., 2026; Jaber and Jaber, 2026), and agent self-improvement (Lee et al., 2026; Zhang et al., 2026b,c; Zheng et al., 2026a), with these discoveries increasingly feeding into the development of more capable AI systems. As agent capabilities improve and self-improvement targets become challenging, discovery increasingly requires long-horizon exploration over vast search spaces, often spanning thousands of proposal–evaluation cycles (OpenAI, 2026; Ye et al., 2026). At this scale, the ability to orchestrate exploration becomes critical (Zheng et al., 2026b). Poor exploration can waste substantial computation and time, severely limiting the efficiency and scalability of RSI.

Existing approaches have largely relied on manually designed exploration strategies that remain largely fixed throughout discovery (Du et al., 2026; Jiang et al., 2026; Novikov et al., 2025; Yan et al., 2026b; Ye et al., 2026). Fixed strategies cannot improve from accumulated discovery experience and may repeatedly allocate computation to ineffective search directions. Recent work therefore seeks to optimize exploration policies online during discovery (Liu et al., 2026a), but doing so faces *(continues on page 2)*

*Page footer (page 1):* Corresponding author(s): xidongwu@google.com, zzhangx@google.com · © 2026 Google. All rights reserved

---

## [Page 2]

*Running header: "Dream-RSI: Recursive Self-Improvement through Evolving Worlds"*

### Figure 1 (diagram, top of page 2)

**What the figure shows.** A flow diagram of the full Dream-RSI loop, with a main loop on top and a "zoom-in" panel below.

*Main loop (top half):*

- **Top-left:** an icon of a document with a `{ }` code symbol and a small flame on it, labeled **"Exploration policy"**. A long arrow labeled **"Update Policy"** runs along the very top of the figure from the right side back to this icon.
- Below it is a **"+"** sign, then a blue robot/agent icon with a laptop, labeled **"❶ Online Explore"**, then another **"+"** sign, then a folder icon labeled **"All previous History"**.
- A solid arrow goes from the agent to a **"Discovery Tree"** (a vertical stack of oval nodes in several columns, with "…" dots). A **dashed arrow labeled "Store"** goes from the tree down-left to the History folder.
- A solid arrow labeled **"❷ Construct Replay Simulator"** goes from the tree to a **"Simulator"** icon (a card showing small tree, magnifier, and chart/target glyphs).
- A dashed arrow labeled **"Update"** goes from the Simulator to the right, into a **"Simulator Pool"** (a stack of overlapping simulator cards).
- The Simulator Pool sits inside a dash-dotted rounded box titled **"❸ Dreaming-based Policy Improvement"**. In that box, a circular pair of arrows labeled **"Interact"** links the Simulator Pool to a robot agent on the right. The agent has a thought-cloud ("dream bubble") filled with many small icons.

*Zoom-in panel (bottom half), reached by a long dashed arrow labeled "Zoom in" from the Dreaming box:*

- It is a second dash-dotted rounded box.
- **Left:** a robot agent icon, a **"+"**, and a folder labeled **"History H"** (small text).
- An arrow labeled **"Propose"** points right to a policy document icon (`{ }`).
- An arrow labeled **"Evaluate"** points down-right to a **"Simulator Pool"** card stack.
- An arrow labeled **"Feedback"** points back down-left from the Simulator Pool to two small boxes: an orange one with a rising line chart labeled **"Scaling curve"** and a grey one with text lines labeled **"Exec traces"**.
- An arrow labeled **"Store to History"** points left from those boxes back to the History folder.

**Caption:** Figure 1 | **Overview of Dream-RSI.** The system operates in a recursive self-improvement loop via three core stages: ① **Online Explore**, where the current exploration policy guides a coding agent to expand a discovery tree and log historical traces; ② **Construct Replay Simulator**, where the generated discovery tree is converted into a reusable simulator pool; and ③ **Dreaming-based Policy Improvement**, where the agent "dreams" up a massive pool of alternative policies in its mind. It then feeds these candidate policies into the replay simulator to simulate executions and derive rapid feedback, continuously refining its strategy (detailed in the Zoom-in box). The updated policy then redeploys for the next round of online exploration.

*(Body text continues from page 1.)*

two fundamental bottlenecks. First, feedback is delayed and expensive at the meta level: unlike evaluating an individual candidate, assessing an exploration policy requires observing how it shapes the subsequent discovery process over many proposal–evaluation cycles. Second, the meta-policy space is vast: a newly proposed policy may perform poorly, so many alternatives may need to be tried. Together, these challenges make meta-level improvement particularly costly: each policy may require a long online rollout before receiving useful feedback, making it difficult to efficiently close the self-improvement loop at the exploration layer.

To address these bottlenecks, our key intuition is simple: a fast and inexpensive simulator of discovery would allow many exploration policies to be evaluated before costly online deployment. **Surprisingly, completed discovery histories already provide such a simulator.** While prior work treats past discovery history merely as static textual context (Hu et al., 2025; Ouyang et al., 2026b) or training data for weight fine-tuning (Wang et al., 2025; Yuksekgonul et al., 2026), a completed discovery process inherently records a structured tree of past exploration decisions and their realized code-execution outcomes. Drawing an analogy to model-based reinforcement learning and World Models (Ha and Schmidhuber, 2018; Hafner et al., 2023) (§2), once organized into a discovery tree, this history can serve as a **replay simulator**¹. As illustrated in Figure 2, an alternative exploration strategy can navigate this pre-recorded tree to traverse different subsets of recorded branches, in different orders, with different parallel groupings and stopping decisions. Because all execution outcomes are already saved in the tree, evaluating a new strategy requires only reading past records without rerunning the underlying discovery agent or evaluator. This transforms meta-policy improvement from an expensive online trial-and-error process into a fast, simulation-based "dreaming" *(continues on page 3)*

---
¹ We use the terms replay simulator and worlds interchangeably.

*Page number: 2*

---

## [Page 3]

procedure.

Building on this insight, we introduce Dream-RSI, a framework for scalable and recursively self-improving meta-exploration in agent-driven discovery. We first make exploration explicit and programmable through a lightweight orchestration layer that controls branching, parallel exploration, and stopping while leaving the underlying coding agent unchanged. Rather than keeping this policy fixed, Dream-RSI establishes a closed-loop self-improvement mechanism across three core stages (Figure 1): **(1) Online Exploration**, where the current policy guides real-world discovery and logs historical execution traces; **(2) Simulator Construction**, where recorded discovery trees are converted into a reusable replay simulator pool; and **(3) Dreaming-based Policy Improvement**, where candidate policies are evaluated via low-cost "dreaming" over the simulator. The updated policy is then redeployed online to generate new discovery experience and expand the simulator pool, closing a RSI loop at the meta-exploration layer.

Empirically, we evaluate Dream-RSI across 8 scientific discovery tasks spanning three distinct domains: algorithm engineering, mathematical optimization, and GPU kernel engineering. In algorithm engineering (Lasso path solver), Dream-RSI outperforms standard libraries like `sklearn` and strong baselines while reducing agent calls by up to 162× over SimpleTES and 1.7× over fixed-exploration baselines. In mathematical optimization (sum-difference, autocorrelation, circle packing), it matches or surpasses strong baselines within 1k generations, yielding over 50× budget savings compared to SimpleTES. In GPU kernel engineering (KernelBench), it either reaches target execution speeds using 1.79×–2.43× fewer generations or improves kernel performance by up to 2.09× under identical budget constraints.

In summary, our main contributions are as follows:

1. **History as Replay Simulator:** We conceptualize completed discovery histories as replay simulators. This makes delayed exploration feedback reusable for efficient meta-exploration policy evaluation.
2. **Meta-Layer RSI Loop (Dream-RSI):** We introduce Dream-RSI, establishing a recursive self-improvement loop that continuously collects discovery histories through online exploration, constructs replay simulators from history to refine meta-exploration strategies via dreaming, and redeploys the upgraded policy online.
3. **Empirical Validation:** We conduct experiments to demonstrate that Dream-RSI improves both discovery effectiveness and efficiency in several settings.

## 2. Motivation: Discovery History as a Replay Simulator

Consider an agent navigating toward a goal in an unfamiliar environment. During its first traversal, the agent may follow inefficient routes, encounter dead ends, backtrack, and gradually construct a map of the surrounding space. Once recorded, however, this experience becomes reusable: the resulting map supports planning without requiring the agent to physically revisit every location. A new navigation policy can instead reason over the accumulated map, avoid known dead ends, reconsider earlier decisions, and compare alternative routes before acting (Gupta et al., 2017).

This idea parallels model-based reinforcement learning (M. Moerland et al., 2023; Sutton, 1990). A model captures how an environment evolves in response to an agent's actions, allowing policies to be trained or evaluated through simulated experience rather than repeated interaction with the real environment (Ha and Schmidhuber, 2018). The Dreamer family (Hafner et al., 2019, 2020, 2023, 2025) demonstrates this principle particularly clearly: an agent learns a compact dynamics model from collected experience and improves its policy by imagining trajectories within that model.

Long-horizon discovery admits an analogous structure. An exploration policy decides which directions to pursue, which candidates to refine, which branches to explore in parallel, and when *(continues on page 4)*

*Page number: 3*

---

## [Page 4]

### Figure 2 (diagram, top of page 4)

**What the figure shows.** A diagram of how alternative policies are replayed over one recorded discovery tree.

- **Top row:** an orange-tinted (faded) document icon with `{ }` labeled **"Selected Policy"**, a **"+"**, the robot/agent icon, a **"+"**, and a folder icon labeled **"All previous History"**. A downward arrow from the agent, labeled **"Online Explore"**, points to the single root node of a tree.
- **The tree ("Discovery History (Simulator)", label at the bottom):** one root oval at the top, then three vertical branches (left, middle, right), each a chain of oval nodes joined by lines. The left branch has 4 pink nodes. The middle branch has a blue-grey top node followed by orange nodes. The right branch has a blue-grey top node followed by grey nodes. Colored translucent overlay regions are drawn on top: a pink region over the left branch that also extends across the top row, a blue region over the top nodes of the middle/right branches, and a light-blue vertical region over the right branch. The overlays show which subsets of recorded nodes different replayed policies traverse.
- **Left side:** an orange-tinted ellipse labeled **"Exploration Policy Distribution"** containing three stars (orange, blue, purple). A dashed orange curved arrow goes from the orange star up to **"Selected Policy"** (top). A dashed blue arrow goes from the blue star to **"Alternative Policy 1 (Replay)"** (blue text), and a dashed purple/pink arrow goes from the purple star to **"Alternative Policy 2 (Replay)"** (pink text); both continue as dashed arrows into the tree. A "…" appears below.
- **Right side:** from the tree, a solid blue arrow leads to **"Score (Alternative Policy 1)"** (blue) and a solid pink arrow to **"Score (Alternative Policy 2)"** (pink), with "…" below. A large right-hand bracket spans these scores, with the heading **"Replay Feedback (Quality ↑; Cost ↓; Latency ↓)"** above it.

**Caption:** Figure 2 | **Discovery history as a replay simulator.** A deployed policy first explores online to generate a structured discovery tree containing historical execution traces (each node denote an attempt with its full observation). Thousands of candidate policies can then be tested within this simulator—evaluating alternative choices of search branches, exploration orders, concurrency levels, and stopping rules. **Since all node outcomes are pre-stored, a single costly online run enables thousands of rapid, zero-execution-cost off-policy evaluations. This enables policy improvement through historical replay: the agent can "dream" over many alternative exploration strategies before redeploying the improved policy online.**

*(Body text continues from page 3.)*

to terminate. Executing the policy online produces a structured discovery history containing the explored branches, decision points, computational costs, and realized outcomes. As illustrated in Figure 2, this history can subsequently be treated as an *empirical replay simulator*: a grounded model of the portion of the discovery space that has already been observed.

Within this replay simulator, alternative exploration policies induce different trajectories through the recorded discovery tree. A policy may select a different subset of branches, prioritize them in a different order, issue different requests in parallel, or stop at an earlier point. Evaluating such a trajectory requires only revealing the outcomes already stored along the selected branches, rather than rerunning the underlying coding agent and evaluator. Consequently, a single expensive online discovery run can support many inexpensive evaluations of alternative exploration strategies.

## 3. Dream-RSI: Recursive Self-Improvement through Evolving Worlds

As shown in Figure 1, Dream-RSI alternates between online exploration and offline "dreaming" to improve an executable *exploration policy* that allocates discovery computation. During the online phase, the policy guides a fixed *discovery agent*, while a fixed *evaluator* scores the resulting candidates and provides diagnostic feedback. The resulting *discovery tree* serves as a *replay world* in which alternative policies can be evaluated using recorded outcomes. A fixed LLM-based *policy-development agent* uses this feedback to revise the *exploration policy* code, and the best evaluated version is deployed for the next online rollout. Only the exploration-policy code changes; the underlying models, evaluator, and execution interfaces remain fixed.

*Page number: 4*

---

## [Page 5]

**Discovery trees and the shared decision interface.** A discovery tree is rooted at $r$, which represents the initial workspace state. Each non-root node $v$ has exactly one *primary parent*, either the root or a previously created node. This parent identifies where the attempt in $v$ begins: the discovery agent resumes the parent's saved workspace and uses its accumulated observations as context to produce a new attempt. Node $v$ preserves this inherited history and records the outcome of the new generation–evaluation attempt, including the resulting filesystem snapshot, generated artifact, evaluation diagnostics, and score $s_v$. Scores follow a fixed task-scoring protocol, with larger values indicating better quality.

In both online execution and offline replay, the exploration policy observes a tree $\mathcal{T}$, initially containing only the root, and selects the nodes from which to continue exploration. The eligible nodes form the set

$$A(\mathcal{T}) = \{r\} \cup \{v \in \mathcal{T} : v \text{ is a leaf}\},$$

where leaves are determined from the currently observed tree. Let $W \ge 1$ be the number of parallel workers, each of which can execute one generation–evaluation request at a time (e.g. concurrent API calls). The exploration policy's action is a batch $C \in A(\mathcal{T}; W)$, where

$$A(\mathcal{T}; W) = \{C \subseteq A(\mathcal{T}) : |C| \le W\}$$

is the feasible batch set. Each selected node specifies the starting point of one attempt, so the batch determines both where exploration continues and how many attempts are scheduled in parallel. Both the online and offline phases use this same decision interface but differ in the transition that follows a selected batch.

**Online rollout.** Let $t = 1, 2, \ldots$ index the outer iterations, starting from an initial policy $\pi_1$ and an empty history $\mathcal{H}_0 = ()$. At iteration $t$, policy $\pi_t$ guides a new online rollout with access to the completed discovery history $\mathcal{H}_{t-1}$. This history provides context for exploration but remains separate from the new tree being constructed. The policy code stays fixed throughout the rollout.

Let $\mathcal{T}_t^k$ denote the new discovery tree after $k$ completed decision rounds, with $\mathcal{T}_t^0 = \{r\}$. The rollout allows at most $K_1$ rounds. At round $k \le K_1$, the *exploration policy* chooses a node batch $C_t^k \in A(\mathcal{T}_t^k; W)$ and each node $v \in C_t^k$ is assigned to a worker. The discovery agent uses $v$'s saved workspace and available context to produce a new candidate, and the evaluator assesses the result. These attempts run in parallel, each producing one new child of its selected parent. Attaching the completed children to the current tree yields $\mathcal{T}_t^{k+1}$, while all previously recorded nodes remain unchanged. This transition is stochastic because the discovery agent may generate different outcomes from the same starting workspace. For the next round, the newly created child becomes the selectable leaf of an extended branch, while the root remains selectable for opening further branches. The rollout ends when the policy selects an empty batch or completes $K_1$ decision rounds. After the rollout terminates, its final tree is recorded as $\mathcal{T}_t$ and appended to the history, giving $\mathcal{H}_t = \mathcal{H}_{t-1} \cup \{\mathcal{T}_t\}$. The method then enters the offline phase using this expanded collection of replay worlds.

**Offline evaluation.** During the offline phase of outer iteration $t$, the history $\mathcal{H}_t$ remains fixed while the method constructs and evaluates $M \ge 1$ policy versions $\pi_t^0, \ldots, \pi_t^{M-1}$, starting with $\pi_t^0 = \pi_t$. Each version is evaluated separately on every historical tree $\mathcal{T}_i$, $i = 1, \ldots, t$, before the next version is developed from the resulting feedback. We use $m$ to index policy versions, $i$ to index replay worlds, and $k$ to count decision rounds within one policy–world evaluation. The outer index $t$ is fixed throughout this phase and is suppressed in the notation for replay trajectories and scores.

For each policy–tree pair $(m, i)$, replay resets the policy's per-rollout state and starts from $\mathcal{T}_i^{m,0} = \{r\}$. Here, $\mathcal{T}_i^{m,k} \subseteq \mathcal{T}_i$ denotes the subtree revealed after $k$ completed rounds. The full recorded tree $\mathcal{T}_i$ remains fixed; only the portion observed by the policy evolves. At each decision, $\pi_t^m$ selects a batch $C_i^{m,k} \in A(\mathcal{T}_i^{m,k}; W)$ using the revealed observations. Unlike online execution, replay returns recorded children of the selected nodes deterministically rather than generating new candidates. After the *exploration policy* takes a nonempty batch $C_i^{m,k}$, the next observed tree is

$$\mathcal{T}_i^{m,k+1} = \mathcal{T}_i^{m,k} \cup \bigcup_{v \in C_i^{m,k}} \text{Child}(v; \mathcal{T}_i, \mathcal{T}_i^{m,k})$$ *(the formula continues onto page 6)*

*Page number: 5*

---

## [Page 6]

where $\text{Child}(v; \mathcal{T}_i, \mathcal{T}_i^{m,k})$ denotes the node set containing unobserved children of $v$ on tree $\mathcal{T}_i$ given the current observed tree $\mathcal{T}_i^{m,k}$. For $v \ne r$, $\text{Child}(v; \mathcal{T}_i, \mathcal{T}_i^{m,k})$ is $v$'s unique recorded child, if one exists. Since $v$ is a leaf of $\mathcal{T}_i^{m,k}$, that child is still unrevealed. For $v = r$, replay returns the earliest-created child of $r$ outside $\mathcal{T}_i^{m,k}$, opening one previously unrevealed branch. In either case, $\text{Child}(v; \mathcal{T}_i, \mathcal{T}_i^{m,k}) = \emptyset$ when no recorded continuation remains. The newly revealed nodes expose their stored observations before the policy makes its next decision.

Replay allows at most $K_2$ decision rounds where each nonempty batch counts as one round, and terminates when the policy selects $C_i^{m,k} = \emptyset$, the round limit $k = K_2$ is reached, or $\mathcal{T}_i^{m,k} = \mathcal{T}_i$, meaning that all recorded nodes have been revealed. Let $k_i^{m,\star} \in \{0, \ldots, K_2\}$ denote the number of completed rounds at termination, yielding the final subtree $\mathcal{T}_i^{m,k_i^{m,\star}} \subseteq \mathcal{T}_i$.

Thus, replay evaluates how far to pursue each opened branch, how to group attempts into parallel batches, and when to open another branch or stop. These decisions may differ across policies, but each branch is traversed in its recorded parent–child order, and no outcomes beyond $\mathcal{T}_i$ are generated.

**Replay objective.** The replay objective balances discovery quality, execution cost, and parallelism. Let $N_i^m = |\mathcal{T}_i^{m,k_i^{m,\star}}| - 1$ be the number of revealed non-root nodes. Although replay itself does not execute new discovery attempts, $N_i^m$ counts the generation–evaluation requests represented by its trajectory. For fixed coefficients $\beta_1, \beta_2 \ge 0$, the replay score is

$$V_i^m = \underbrace{\max_{v \in \mathcal{T}_i^{m,k_i^{m,\star}}} s_v}_{\text{discovery quality}} \;-\; \underbrace{\beta_1 N_i^m}_{\text{execution cost}} \;+\; \underbrace{\beta_2 \frac{N_i^m}{\max\{1,\, k_i^{m,\star}\}}}_{\text{parallelism bonus}}. \qquad (1)$$

*(Rendered page: the three terms of Equation (1) carry labeled braces beneath them — "discovery quality" under the max term, "execution cost" under the $\beta_1 N_i^m$ term, and "parallelism bonus" under the fraction term. Equation number (1) is at the right margin.)*

The first term measures the best solution quality attained during replay. The second penalizes the number of attempted generations. For a nonempty replay, the third rewards the average number of attempts executed per decision round, favoring policies that batch useful continuations rather than execute them sequentially.

**Policy improvement and selection.** The evaluation score of policy version $\pi_t^m$ is its average replay score across the fixed history,

$$V^m = \frac{1}{t} \sum_{i=1}^{t} V_i^m.$$

The offline phase begins by evaluating the current policy $\pi_t^0 = \pi_t$. For each $m = 0, \ldots, M-1$, the *policy-development agent* examines the replay trajectories and scores of $\pi_t^m$, together with feedback from earlier revisions, to identify successful decisions and recurring failures. It then revises the executable policy code to produce $\pi_t^{m+1}$, which is evaluated on the same $t$ replay worlds. Replay feedback is available to the development agent between revisions.

After $M$ revisions, the next online policy is selected from all $M$ evaluated versions as $\pi_{t+1} = \pi_t^{m^\star}$, where $m^\star \in \arg\max_{m \in \{0, \ldots, M-1\}} V^m$. Because the candidate set includes the current policy, this selection satisfies $V^{m^\star} \ge V^0$. Thus, the selected policy $\pi_{t+1}$ is no worse than the current policy $\pi_t$ in average replay score on the fixed history $\mathcal{H}_t$. The selected policy is then deployed online to collect $\mathcal{T}_{t+1}$, expanding the history available for the next offline improvement phase.

## 4. Experiments

We evaluate Dream-RSI across three scientific discovery domains: algorithm engineering, kernel optimization and math optimization. Our primary controlled baseline is Recursive Fixed Exploration, *(continues on page 7)*

*Page number: 6*

---

## [Page 7]

which uses the same underlying discovery setting and initialization but keeps the exploration policy fixed across recursive discovery rounds. We additionally compare against task-specific domain baselines.

Across all tasks, Dream-RSI and Recursive Fixed Exploration use the same discovery agent, evaluator, initialization, and resource constraints. Both methods start from the same manually designed exploration policy. This exploration policy follows a simple *parallel refining* strategy: it launches multiple independent exploration workspaces in parallel, with each workspace maintaining its own local discovery trajectory and repeatedly refining its current candidate based on the history accumulated within that workspace. The two methods therefore follow the same exploration policy in the first discovery round. In subsequent rounds, while Recursive Fixed Exploration keeps its exploration policy static, Dream-RSI progressively refines the policy by dreaming over a replay simulator conditioned on accumulated global discovery history, subsequently deploying the updated policy in each new round. The discovery cost is quantified by the total cumulative number of discovery-agent calls.

Specifically, we evaluate Gemini-3.1 Pro and Gemini-3.7-Flash across multiple recursive discovery rounds via the Gemini CLI². Under Recursive Fixed Exploration, each round for Gemini-3.1 Pro executes 10 parallel workspaces with up to 11 refinement steps (10 × 11 = 110 discovery-agent calls), whereas Gemini-3.7-Flash operates 32 parallel workspaces with up to 20 refinement steps (32 × 20 = 640 calls). Dream-RSI maintains identical per-round budgets, aligning with the baseline in Round 1 while progressively updating its policy in subsequent rounds. Further details on recursive rounds, task setups, resource budgets, and evaluation protocols follow below.

### 4.1. Algorithm Engineering

In this task, we consider **Lasso Regularization Path** as our algorithm-engineering task, a fundamental computational primitive in high-dimensional statistics that is widely used in model selection and cross-validation across domains such as genomics and finance. We follow the benchmark setting of SimpleTES (Ye et al., 2026), where the goal is to discover efficient implementations of the complete Lasso regularization path while preserving numerical correctness. During discovery, we use the same 17 synthetic instances as SimpleTES, which cover diverse problem regimes in terms of dimensionality, sparsity, feature correlation, and active-set structure. To evaluate whether the discovered algorithms generalize beyond the search distribution, we additionally evaluate them on six held-out downstream datasets spanning both biological and non-biological domains.

**Baselines and Setup.** We compare against standard Lasso solvers **sklearn** (Pedregosa et al., 2011) and **glmnet** (Friedman et al., 2010), as well as **SimpleTES** (Ye et al., 2026), which uses GPT-OSS-120B with a reported budget of 51,200 generations. We additionally include Recursive Fixed Exploration as our controlled baseline. Specifically, we run both Recursive Fixed Exploration and Dream-RSI for 5 rounds.

**Main Results.** Figure 3(a) summarizes the Lasso discovery results. Across both discovery-agent backbones, Dream-RSI achieves a better downstream quality–compute trade-off than Recursive Fixed Exploration. With Gemini-3.1 Pro, it reduces the average runtime across the six held-out datasets from 3587.1 ms to 2931.0 ms while using only 317 discovery-agent calls, compared with 550 calls for fixed exploration. With Gemini-3.7-Flash, Dream-RSI further reduces the average runtime from 2516.7 ms to 2350.6 ms using 1879 calls instead of 3200. Despite using substantially less discovery compute, *(continues on page 8)*

---
² https://geminicli.com/

*Page number: 7*

---

## [Page 8]

### Figure 3 (a): Final performance — table at top of page 8

Column groups: **Non-biological** (Gisette, RCV1) and **Biological** (DNA, Leukemia, Colon, Duke Breast). All numbers are wall-clock runtimes in ms (lower is better); the last column is the average over the six held-out datasets. The best (lowest) average, **2350.6**, is printed in bold.

| Method | Model | Compute | Gisette | RCV1 | DNA | Leukemia | Colon | Duke Breast | Avg. |
|---|---|---|---|---|---|---|---|---|---|
| *Previous solvers* | | | | | | | | | |
| sklearn | – | – | 11275.2 | 252881.7 | 93.8 | 227.2 | 229.8 | 374.0 | 44180.3 |
| glmnet | – | – | 9063.6 | 73072.8 | 351.9 | 45.0 | 24.2 | 47.7 | 13767.5 |
| SimpleTES | gpt-oss-120b | 51,200 | 3141.9 | 19625.6 | 15.9 | 15.5 | 11.6 | 18.1 | 3804.8 |
| SimpleTES † | gpt-oss-120b | 51,200 | 8651.0 | 41143.1 | 37.6 | 28.2 | 19.5 | 31.1 | 8318.4 |
| *Our System* | | | | | | | | | |
| Recursive Fixed Exploration | Gemini-3.1-Pro | 550 | 1861.8 | 19550.1 | 41.5 | 26.1 | 14.5 | 28.4 | 3587.1 |
| | Gemini-3.7-Flash | 3200 | 1133.1 | 13873.0 | 29.8 | 24.1 | 15.7 | 24.4 | 2516.7 |
| **Dream-RSI** | Gemini-3.1-Pro | 317 | 2841.0 | 14616.0 | 49.9 | 30.2 | 16.4 | 32.5 | 2931.0 |
| | Gemini-3.7-Flash | 1879 | 1091.9 | 12923.4 | 31.4 | 21.0 | 12.2 | 23.6 | **2350.6** |

*Notes on the rendering:* the Method cell is printed once for each pair of rows (the second row of each pair is blank under Method). The "†" mark after the second SimpleTES row is not explained anywhere on pages 1–10. The sub-caption under the table reads **"(a) Final performance."**

### Figure 3 (b): Recursive Discovery Dynamics — two line charts

Shared **y-axis label: "Avg. Runtime (ms)"**; each chart has **"Discovery Compute"** on the x-axis. Legend below both charts: **blue square line = Recursive Fixed Exploration**, **red circle line = Dream-RSI**. Each marker carries a small number (1–5) for the recursive round.

- **Left chart — "Gemini-3.1-Pro".** Y-axis ticks 3,000 / 4,000 / 5,000 / 6,000; x-axis ticks 100 / 300 / 500.
  - *Blue (Recursive Fixed Exploration), approximate:* round 1 near x≈100, y≈5,250; round 2 near x≈220, y≈5,350; round 3 near x≈320, y≈5,300; round 4 near x≈440, y≈4,700; round 5 near x≈550, y≈3,600 (the table gives 550 calls and 3587.1 ms).
  - *Red (Dream-RSI), approximate:* rounds 1–3 clustered near x≈100–150, y≈5,250–5,350; round 4 near x≈225, y≈5,700 (the highest point on the chart); round 5 drops steeply to x≈317, y≈2,930 (the table gives 317 calls and 2931.0 ms), well below the blue line's endpoint.
- **Right chart — "Gemini-3.7-Flash".** Y-axis ticks 2,250 / 2,500 / 2,750 / 3,000; x-axis ticks 1,000 / 2,000 / 3,000.
  - *Blue, approximate:* round 1 near x≈640, y≈2,730; round 2 near x≈1,280, y≈2,990; round 3 near x≈1,920, y≈3,010; round 4 near x≈2,560, y≈2,910; round 5 near x≈3,200, y≈2,517 (table: 3200 calls, 2516.7 ms). The blue curve rises, peaks at rounds 2–3, then falls.
  - *Red, approximate:* round 1 coincides with blue at x≈640, y≈2,730; it then drops sharply at round 2 (x≈900, y≈2,390) and stays low through rounds 3–5 (y≈2,330–2,380), ending near x≈1,879, y≈2,350 (table: 1879 calls, 2350.6 ms).
  - Sub-caption under the charts: **"(b) Recursive Discovery Dynamics."**

**Caption:** Figure 3 | **Lasso regularization-path discovery results. (a)** Final wall-clock runtime on six held-out downstream tasks; lower is better. **Compute** denotes the cumulative number of discovery-agent calls. **(b) Recursive discovery dynamics.** Average downstream runtime across six held-out tasks versus cumulative discovery compute for Gemini-3.1-Pro and Gemini-3.7-Flash. Numbers next to markers denote recursive rounds (iterations). Lower is better.

*(Body text continues from page 7.)*

the resulting solvers also outperform the standard sklearn and glmnet implementations on all six held-out datasets. Compared with SimpleTES, which uses 51,200 generations, Dream-RSI achieves lower average downstream runtime with roughly two orders of magnitude fewer discovery-agent calls. Notably, the program discovered by Gemini-3.1-Pro appears particularly well suited to large-scale matrices such as RCV1. In contrast, Gemini-3.7-Flash discovers a more general-purpose program that performs consistently across different problem scales.

**Recursive Discovery Dynamics.** Figure 3(b) illustrates the trajectory of downstream performance across recursive discovery rounds relative to cumulative discovery compute. By design, both methods share identical search behavior in the initial round. In subsequent rounds, Recursive Fixed Exploration maintains a static exploration policy, whereas Dream-RSI progressively refines and redeploys its policy via dreaming over accumulated discovery history. Consequently, the two trajectories diverge markedly: Dream-RSI consistently achieves superior downstream performance while requiring substantially lower cumulative compute across both Gemini-3.1-Pro and Gemini-3.7-Flash.

*Page number: 8*

---

## [Page 9]

### Table 1 (top of page 9)

**Caption:** Table 1 | Performance comparison on mathematical discovery tasks. Higher is better for **Sum Diff** and **Circle Packing**, while lower is better for **Auto Correlation**. Best results are shown in **bold**.

| Method | LLM | Sum Diff (↑) | Auto Correlation (↓) | Circle Packing (↑) |
|---|---|---|---|---|
| AlphaEvolve | Gemini-2.0 Pro + Flash | – | 1.455700 | 2.635862 |
| AlphaEvolveV2 | Gemini-2.0 Pro + Flash | 1.121936 | – | **2.635983** |
| OpenEvolve | - | – | 1.460000 | - |
| CodeEvolve | - | – | – | 2.635980 |
| ShinkaEvolve | Mixed | – | 1.457800 | 2.635982 |
| TTS-Discovery | Qwen3-8B | – | – | **2.635983** |
| ThetaEvolve | Distilled-Qwen3-8B | – | 1.493000 | **2.635983** |
| EvoX | Gemini-3.0-Pro | – | 1.458900 | 2.635900 |
| SimpleTES | GPT-OSS-120B | 1.143975 | **1.453675** | **2.635983** |
| *Our System* | | | | |
| Recursive Fixed Exploration | Gemini-3.1-Pro | 1.144047 | 1.456001 | **2.635983** |
| **Dream-RSI** | Gemini-3.1-Pro | **1.145427** | 1.456375 | **2.635983** |

*(A horizontal rule separates the "Our System" block from the baseline rows.)*

**Discovered Solver Analysis.** We further analyze the discovered solver, with its implementation provided in the Appendix C. Unlike SimpleTES, which switches between LARS and coordinate descent according to problem dimensions, the discovered solver introduces adaptivity within the active-set optimization itself. It combines strong-rule screening with Cauchy–Schwarz-based KKT pruning, selectively recomputing exact gradients only when the bound cannot certify a feature and falling back to a full refresh when pruning becomes ineffective. This adaptive verification scheme is further integrated with efficient active-set bookkeeping, lazy Gram-matrix construction, and hardware-aware implementation.

### 4.2. Mathematics Optimization

We further evaluate Dream-RSI on three mathematical discovery tasks spanning discrete combinatorial optimization, geometric optimization, and functional optimization: the **Sum–Difference Problem**, **Circle Packing**, and **Autocorrelation Inequalities**. The goal of these problems is to discover high-quality solutions that optimize task-specific mathematical objectives under their respective constraints. Formal definitions of the three tasks are provided in Appendix.

We use Gemini-3.1 Pro via the Gemini CLI as the discovery agent for both Recursive Fixed Exploration and Dream-RSI for 10 rounds. For each task, the agent iteratively proposes and evaluates candidate constructions or optimization procedures according to the task-specific objective. We compare against a broad set of existing automated discovery systems, including AlphaEvolve (Novikov et al., 2025), AlphaEvolveV2 (Georgiev et al., 2025), OpenEvolve (Sharma, 2025), CodeEvolve (Assumpção et al., 2025), ShinkaEvolve (Lange et al., 2026), TTS-Discovery (Yuksekgonul et al., 2026), ThetaEvolve (Wang et al., 2025), EvoX (Liu et al., 2026a), and SimpleTES (Ye et al., 2026).

**Results.** Table 1 summarizes the results across the three mathematical discovery tasks. Dream-RSI achieves a Sum–Difference score of 1.145427, outperforming SimpleTES and Recursive Fixed Exploration. On Circle Packing, it reaches 2.635983, matching the strongest reported result among the compared methods. For Autocorrelation, Dream-RSI obtains 1.456375, remaining competitive with existing discovery systems. Notably, SimpleTES achieves state-of-the-art performance on Autocorre- *(continues on page 10)*

*Page number: 9*

---

## [Page 10]

### Figure 4 (top of page 10): GPU kernel engineering results — four panels

**Legend (top, centered):** a **solid blue line with filled circle markers = Dream-RSI**; a **dashed grey line with open circle markers = Recursive Fixed Exploration**.

All four panels are step-style curves (performance only moves up when a new best is found). Each panel has the **x-axis "Number of Generations"** with ticks 0 / 250 / 500 / 750 / 1,000 (labeled on the bottom row), and the y-axis labeled **"Performance (1/ms)"** (on the left column). Each panel has a blue callout box.

| Panel | Y-axis range | Callout text | What the curves look like (approximate) |
|---|---|---|---|
| **VGG16** (top-left) | 0.35 – 0.55 | **2.43× fewer costs (comparable performance)** | Dream-RSI (blue) starts near 0.37 at about 100 generations, then jumps early to about 0.445 and climbs in small steps to about 0.53 by about 400 generations, where it ends. Fixed Exploration (grey dashed) stays near 0.37 until about 220, steps to about 0.45, then about 0.51 near 330, and keeps creeping up to about 0.535 at 1,000 generations. |
| **LayerNorm** (top-right) | 1.05 – 1.15 | **1.79× fewer costs (comparable performance)** | Dream-RSI starts near 1.03, rises to about 1.065, about 1.105, then plateaus around 1.12 between roughly 350 and 550 generations, where it ends. Fixed Exploration starts near 1.03, steps to about 1.098 near 220, about 1.115–1.12 afterwards, and reaches about 1.127 from about 660 generations to 1,000. |
| **ConvDiv** (bottom-left) | 0.4 – 2 (ticks 0.4, 0.8, 1.2, 1.6, 2) | **2.09× higher score (Similar Budget)** | Dream-RSI starts near 0.43 and climbs in large steps: about 0.62 near 220, about 0.85 near 310, about 1.4 near 390, about 1.5 near 520, about 1.75 near 600–680, and about 1.87–1.9 by about 700–780 generations, where it ends. Fixed Exploration stays low: about 0.5 for the first few hundred generations, about 0.6, about 0.87, and finally about 1.28 around 880–1,000. |
| **ConvMax** (bottom-right) | 0.25 – 0.45 | **1.44× higher score (Similar Budget)** | Dream-RSI stays flat near 0.24, then steps to about 0.26 and about 0.28 and stays at about 0.28 until about 660 generations, where it jumps sharply to about 0.43. Fixed Exploration steps from about 0.24 to about 0.25, then to about 0.29, and plateaus near 0.30 through 1,000 generations. |

**Caption:** Figure 4 | **GPU kernel engineering results.** Discovery performance of Dream-RSI and Recursive Fixed Exploration as a function of the number of generations. On VGG16 and LayerNorm, Dream-RSI reaches comparable performance with 2.43× and 1.79× fewer generations, respectively. On ConvDiv and ConvMax, it achieves 2.09× and 1.44× higher performance under comparable discovery budgets. Higher is better for all tasks.

*(Body text continues from page 9.)*

lation Inequalities, but requires 51,200 generations, significantly more than the fewer than 1,000 generations used by our approach. Overall, these results show that our Dream-RSI generalize well on mathematics optimization.

### 4.3. Kernel Engineering

We further evaluate Dream-RSI on **GPU kernel engineering**, where the goal is to automatically discover high-performance implementations of kernels while preserving numerical correctness. Unlike mathematical discovery, kernel engineering requires reasoning jointly about algorithmic structure, memory access, parallelization, and hardware-specific optimizations, providing a substantially different testbed for evaluating whether our Dream-RSI generalizes across discovery domains.

We consider four representative kernel-engineering tasks from KernelBench (Ouyang et al., 2025): **VGG16**, **LayerNorm**, **ConvDiv**, and **ConvMax**. Candidate implementations are evaluated by their execution performance, measured as inverse runtime (1/ms), subject to correctness checks against the reference implementation. We use Gemini-3.1 Pro as the coding agent and compare Dream-RSI with Recursive Fixed Exploration under the same evaluation protocol and initialization.

**Results.** Figure 4 shows the discovery trajectories as the number of generations increases. On VGG16 and LayerNorm, Dream-RSI reaches comparable final performance using 2.43× and 1.79× fewer generations, respectively. On ConvDiv and ConvMax, under comparable discovery budgets, *(continues on page 11 — not included in this part)*

*Page number: 10*

---

**End of DREAM_1.md (PDF pages 1–10).**
