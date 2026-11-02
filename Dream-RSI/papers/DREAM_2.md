# DREAM_2.md — Dream-RSI: Recursive Self-Improvement through Evolving Worlds (PDF pages 10–19)

**Source:** `https://github.com/zhengkid/Dream-RSI.git` → `papers/Dream-RSI.pdf` (36 pages, A4, produced with LaTeX / pdfTeX).
**Coverage of this file:** pages **10 through 19** (10 pages) of the 36-page PDF.
**Running header on every page:** "Dream-RSI: Recursive Self-Improvement through Evolving Worlds" (centered, thin rule beneath). **Page number** is at the bottom right, above a thin rule.
**Typography notes:** the name "Dream-RSI" is set in small caps in the PDF (written here as Dream-RSI). Citations such as "(Ouyang et al., 2025)" are blue clickable links in the PDF; they are kept here as plain text.

**How this file was made:** the text layer was extracted from the PDF, then checked against one rendered screenshot per page (10 screenshots total, pages 10–19). Charts and equations were read from the screenshots. Numbers printed on the charts (e.g. 2.43×, 0.427, 110) are exact. Values marked with "≈" were read off the plotted lines by eye and are approximate.

## Page map

| PDF page | Contents |
|---|---|
| 10 | Figure 4 (GPU kernel results); end of math results paragraph; §4.3 Kernel Engineering; start of "Results" |
| 11 | End of "Results"; §5 Further Analysis (5.1, 5.2) with Figures 5 and 6; start of §6 Related Work |
| 12 | Rest of Related Work (3 paragraphs); §7 Conclusion |
| 13 | References (Anthropic … Huang 2026c) |
| 14 | References (Jaber … Pedregosa) |
| 15 | References (Romera-Paredes … Zhang 2026a) |
| 16 | References (Zhang 2026b … Zheng 2026b); rest of page blank |
| 17 | Appendix A — Problems 1, 2, 3 |
| 18 | Appendix A — Problem 4; Appendix B intro; B.1 and start of Listing 1 |
| 19 | Rest of Listing 1; B.2 and start of Listing 2 |

---

**[PAGE 10]**

*Layout: Figure 4 fills the top half of the page (a 2×2 grid of charts with a shared legend), followed by its caption, the tail of a paragraph from the previous page, Section 4.3, and the first half of the "Results" paragraph.*

### Figure 4 (visual description)

**Legend (top, centered):** a thick solid **blue** line with a filled circle marker = **Dream-RSI**; a thin **gray dashed** line with small markers = **Recursive Fixed Exploration**.

**Structure:** four small charts in a 2×2 grid, each with a bold title above it: top-left **VGG16**, top-right **LayerNorm**, bottom-left **ConvDiv**, bottom-right **ConvMax**. The y-axis label **"Performance (1/ms)"** appears to the left of each row. The x-axis label **"Number of Generations"** appears under the bottom row, with ticks **0, 250, 500, 750, 1,000**. The top row uses the same 0–1,000 range but shows no x tick labels. Each curve is a **step function** (best performance found so far); each step marks a new best candidate. The first marker of both curves in every panel is a **hollow circle** at roughly 100 generations (the starting point); later Dream-RSI markers are filled blue circles. Each panel has a boxed blue-text annotation:

| Panel | y-axis ticks | Annotation text in the panel |
|---|---|---|
| VGG16 | 0.35, 0.4, 0.45, 0.5, 0.55 | **2.43× fewer costs** (comparable performance) |
| LayerNorm | 1.05, 1.1, 1.15 | **1.79× fewer costs** (comparable performance) |
| ConvDiv | 0.4, 0.8, 1.2, 1.6, 2 | **2.09× higher score** (Similar Budget) |
| ConvMax | 0.25, 0.3, 0.35, 0.4, 0.45 | **1.44× higher score** (Similar Budget) |

**What the curves show (approximate, read by eye):**

- **VGG16:** both curves start just above 0.35 (≈0.37). Dream-RSI climbs in several quick steps within the first ≈400 generations (≈0.37 → ≈0.45 → ≈0.47 → ≈0.51 → ≈0.52–0.53) and then stays flat. Recursive Fixed Exploration stays flat until ≈200 generations, steps to ≈0.45, then ≈0.51 near ≈300, and creeps up slowly, reaching a similar final level only near the right edge (≈900–1,000 generations). That gap is the "2.43× fewer costs" claim.
- **LayerNorm:** both start just below 1.05 (≈1.03). Dream-RSI steps to ≈1.065, then ≈1.10, then ≈1.12 by ≈350 generations and holds that level (last marker ≈550). Recursive Fixed Exploration steps to ≈1.10 early, sits around ≈1.115–1.12 through the middle, and finally steps to ≈1.13 (around ≈650+), holding until 1,000. "1.79× fewer costs" is for reaching comparable performance.
- **ConvDiv:** Dream-RSI goes from ≈0.4 → ≈0.6 (≈220) → ≈0.85 (≈300) → ≈1.4 (≈390) → ≈1.5 (≈450–520) → ≈1.75 (≈610) → ≈1.85 (≈700) → ≈1.9 (≈780). Recursive Fixed Exploration stays low (≈0.5 from ≈220 to ≈540), reaches ≈0.87–0.9 around ≈650–850, and jumps to ≈1.3 near ≈870, flat to 1,000. Dream-RSI ends clearly higher: "2.09× higher score (Similar Budget)".
- **ConvMax:** Dream-RSI creeps from ≈0.24 → ≈0.245 → ≈0.26 → ≈0.275–0.28 (a cluster of markers between ≈370 and ≈550) and then makes one big jump at ≈660 generations to ≈0.43 (the highest point in the panel). Recursive Fixed Exploration moves to ≈0.295–0.30 by ≈420 and stays flat near 0.3 through 1,000. "1.44× higher score (Similar Budget)".

**Figure 4 caption (verbatim):**
Figure 4 | **GPU kernel engineering results.** Discovery performance of Dream-RSI and Recursive Fixed Exploration as a function of the number of generations. On VGG16 and LayerNorm, Dream-RSI reaches comparable performance with 2.43× and 1.79× fewer generations, respectively. On ConvDiv and ConvMax, it achieves 2.09× and 1.44× higher performance under comparable discovery budgets. Higher is better for all tasks.

### Text carried over from page 9

*(This paragraph begins on page 9, outside this file's range. On page 10 it starts mid-word with "lation".)*

lation Inequalities, but requires 51,200 generations, significantly more than the fewer than 1,000 generations used by our approach. Overall, these results show that our Dream-RSI generalize well on mathematics optimization.

### 4.3. Kernel Engineering

We further evaluate Dream-RSI on **GPU kernel engineering**, where the goal is to automatically discover high-performance implementations of kernels while preserving numerical correctness. Unlike mathematical discovery, kernel engineering requires reasoning jointly about algorithmic structure, memory access, parallelization, and hardware-specific optimizations, providing a substantially different testbed for evaluating whether our Dream-RSI generalizes across discovery domains.

We consider four representative kernel-engineering tasks from KernelBench (Ouyang et al., 2025): **VGG16**, **LayerNorm**, **ConvDiv**, and **ConvMax**. Candidate implementations are evaluated by their execution performance, measured as inverse runtime (1/ms), subject to correctness checks against the reference implementation. We use Gemini-3.1 Pro as the coding agent and compare Dream-RSI with Recursive Fixed Exploration under the same evaluation protocol and initialization.

**Results.** Figure 4 shows the discovery trajectories as the number of generations increases. On VGG16 and LayerNorm, Dream-RSI reaches comparable final performance using 2.43× and 1.79× fewer generations, respectively. On ConvDiv and ConvMax, under comparable discovery budgets,
*(paragraph continues on page 11)*

*Page number printed: 10*

---

**[PAGE 11]**

*Layout: top of page continues the Results paragraph. Below it, Section 5 has body text in a narrow left column with a figure in the right column (Figure 5 beside 5.1; Figure 6 beside 5.2 and the start of Section 6). Full-width text resumes at the bottom.*

Dream-RSI achieves 2.09× and 1.44× higher performance, respectively. These results show that adapting the exploration policy across recursive rounds can improve the efficiency and effectiveness of long-horizon discovery.

## 5. Further Analysis

### 5.1. Analysis of Historical Inductive Biases in Long-Horizon Discovery

We further investigate how the nature of the historical inductive bias affects long-horizon discovery. A natural alternative for utilizing history is to abstract prior trajectories into high-level directional insights, which are directly injected into the prompt as explicit semantic guidance for subsequent rounds. To evaluate the efficacy of this prompt-level semantic guidance, we apply it to both Recursive Fixed Exploration and Dream-RSI. As illustrated in Figure 5, explicit directional guidance consistently underperforms its unguided counterpart across both paradigms under equivalent discovery budgets. These results suggest that in long-horizon discovery—where multiple parallel threads are deployed for exploration—imposing strong semantic inductive biases regarding future search directions tends to over-constrain the search space and impede diverse exploration.

### Figure 5 (visual description)

**Legend (above the plot, 2×2):** row 1: thick solid **blue** line with filled circle = **Dream-RSI**; **gray dashed** line = **Fixed Exploration**. Row 2: **orange** dashed/dotted line with markers = **Dream-RSI + Guidance**; **green** dotted line = **Fixed + Guidance**.

**Axes:** y-axis "Performance (1/ms)" with ticks 0.4, 0.8, 1.2, 1.6, 2; x-axis "Number of Generations" with ticks 0, 250, 500, 750, 1,000. All curves are step functions of best-so-far performance on ConvDiv.

**What the curves show (approximate):**

- **Dream-RSI (blue):** the best curve; rises in steps to ≈1.9 by ≈780 generations (≈0.6 at ≈220, ≈1.4 at ≈390, ≈1.5 at ≈450–520, ≈1.75 at ≈610, ≈1.85 at ≈700).
- **Dream-RSI + Guidance (orange):** jumps early (≈0.9 by ≈200 generations, above Dream-RSI at that point), reaches ≈1.1 at ≈290 and ≈1.3 at ≈520, then flattens near ≈1.38 and ends around ≈1.5 near ≈850 generations. Ends below unguided Dream-RSI.
- **Fixed Exploration (gray dashed):** ≈0.5 from ≈220 to ≈540, ≈0.87–0.9 around ≈650–850, then a late jump to ≈1.3 near ≈870, flat to 1,000.
- **Fixed + Guidance (green dotted):** the lowest curve; hovers around ≈0.5–0.65 and stays nearly flat to ≈850. Ends below unguided Fixed Exploration.

**Figure 5 caption (verbatim):**
Figure 5 | Discovery performance on ConvDiv. Using history as an interactive replay simulator outperforms using it only as guidance.

### 5.2. Analysis of Evolution of Exploration Behavior

Figure 6 illustrates how the learned exploration policy evolves across recursive rounds on ConvDiv. As shown, the exploration policy exhibits a clear adaptive pattern: as performance improves, it initially conserves discovery compute (e.g., reducing the number of evaluated attempts from 110 to 50). When progress subsequently plateaus, it increases exploration effort again, coinciding with further performance gains..

*(The double period "gains.." is as printed in the PDF.)*

### Figure 6 (visual description)

Two stacked sub-charts that share the x categories **E0 … E8** (nine recursive execution rounds).

**(a) Round-best performance** (top sub-chart): a **blue line with hollow circle markers**, y-axis "Performance (1/ms)" with ticks 0.5, 1, 1.5, 2. Each point has a blue value label. The line rises monotonically, with the largest jump from E2 to E3 and a plateau between E3–E5:

| Round | E0 | E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 |
|---|---|---|---|---|---|---|---|---|---|
| Round-best performance (1/ms) | 0.427 | 0.625 | 0.855 | 1.403 | 1.488 | 1.499 | 1.770 | 1.880 | 1.898 |

Sub-chart caption under the plot: **(a) Round-best performance**.

**(b) Exploration effort** (bottom sub-chart): **light-blue bars** with darker blue outlines, plus a **blue line with hollow circle markers** connecting the bar tops. y-axis "Evaluated attempts" with ticks 0, 50, 100; x-axis label "Recursive execution round". Value labels above the bars:

| Round | E0 | E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 |
|---|---|---|---|---|---|---|---|---|---|
| Evaluated attempts | 110 | 110 | 87 | 80 | 50 | 92 | 80 | 91 | 86 |

The bars drop from 110 (E0, E1) to a minimum of 50 at E4 (the round where performance plateaus ≈1.488→1.499 between E4 and E5), then rebound to 92 at E5 and stay in the 80–92 range afterward. Sub-chart caption under the plot: **(b) Exploration effort**.

**Figure 6 caption (verbatim):**
Figure 6 | **Evolution of exploration behavior on ConvDiv. (a)** Round-best performance across recursive execution rounds. **(b)** The number of evaluated attempts in each round.

## 6. Related Work

**AI-Driven Scientific and Algorithmic Discovery.** LLM-based discovery systems iteratively generate, evaluate, and refine candidate solutions using prior artifacts and feedback, as in AlphaEvolve (Novikov et al., 2025), OpenEvolve (Sharma, 2025), CodeEvolve (Assumpção et al., 2025), ShinkaEvolve (Lange et al., 2026), PACEvolve (Yan et al., 2026b), DeltaEvolve (Jiang et al., 2026) and MLEvolve Du et al.
*(sentence continues on page 12)*

*Page number printed: 11*

---

**[PAGE 12]**

*Layout: full-width text only (no figures). Related Work continues with three more bolded run-in paragraphs, then Section 7 Conclusion; lower part of the page is blank.*

*(continuation of the "AI-Driven Scientific and Algorithmic Discovery" paragraph from page 11)* (2026). More recent work emphasizes the importance of exploration itself: SkyDiscover provides adaptive discovery infrastructure (Liu et al., 2026b), SwarmResearch dynamically orchestrates multiple search branches (Virk et al., 2026), and EvoX (Liu et al., 2026a) explicitly optimizes search strategies rather than only candidate solutions. This shift makes exploration a meta-level optimization problem, but useful supervision for exploration strategies is expensive and delayed because their quality often becomes apparent only after long discovery rollouts.

**Self-Evolving Agents.** A broader line of work studies agents that improve their own components during interaction. Prior methods evolve model weights (Huang et al., 2026a,c), agent harnesses (Lee et al., 2026; Zhang et al., 2026b), contexts (Zhang et al., 2026d), skills (Ouyang et al., 2026a; Wu et al., 2026b; Zhang et al., 2026a), model behavior through test-time learning (Wang et al., 2025; Wu et al., 2026a; Yan et al., 2026a; Yuksekgonul et al., 2026), rubrics (Xiong et al., 2026), environments (Huang et al., 2026b) and other applications (Dai et al., 2026). Most operate at the *object level*, improving components used for task execution or reasoning. Recent work has begun to optimize meta-level mechanisms, including search strategies and self-improvement procedures (Kim et al., 2026; Liu et al., 2026a; Wang et al., 2026; Yan et al., 2026a; Zhang et al., 2026c). However, such meta-level strategies are difficult to improve because their quality is often revealed only after costly long-horizon rollouts. Dream-RSI makes this meta-level optimization recursive and off-policy by turning accumulated discovery history into replay simulators, allowing exploration controllers to be repeatedly evaluated, improved, and redeployed without rerunning the underlying discovery process.

**Memory, History, and Experience Reuse.** Prior work reuses agent experience as search history, context, memory, reusable skills, or training signals. DeltaEvolve structures evolutionary history through semantic deltas (Jiang et al., 2026); SwarmResearch and MLEvolve use cross-branch or retrospective information to guide subsequent search (Du et al., 2026; Virk et al., 2026); and other work improves how agents access and retain experience through evolving contexts, broader harness state, libraries, or skills (Lee et al., 2026; Ouyang et al., 2026a; Xu et al., 2026; Zhang et al., 2026d). We take a different view: rather than using exploration history only as context or memory for the next decision, we organize it as a *replay simulator* in which many alternative exploration controllers can be evaluated cheaply. This turns previously collected discovery experience into reusable feedback for meta-level optimization, alleviating the scarcity and high cost of training signals for improving exploration strategies.

## 7. Conclusion

We presented Dream-RSI, a framework for recursive self-improvement of exploration in recursive self improvement. By converting accumulated discovery history from static context into an active, replayable simulator, Dream-RSI addresses the core bottleneck of meta-optimization: delayed and expensive feedback, which is especially severe in long-horizon discovery settings. By ‘dreaming’ within replay simulators constructed from historical discovery trees, Dream-RSI evaluates candidate exploration policies rapidly and at negligible execution cost. The improved policies are then redeployed online to drive further discovery and expand the simulator pool, closing the recursive self-improvement loop. Across algorithm engineering, mathematical optimization, and GPU kernel engineering, Dream-RSI achieves competitive or improved discovery quality while substantially reducing discovery cost in several settings.

*Page number printed: 12*

---

**[PAGE 13]**

*Layout: single column of reference entries. Heading "References" at top. arXiv/journal/venue names are in italics in the PDF; URLs are in a blue monospace font.*

## References

- Anthropic. Learning more about claude’s mathematical capabilities. `https://www.anthropic.com/research/riemann-zeta`, Aug. 2026. Accessed: 2026-08-13.
- H. Assumpção, D. Ferreira, L. Campos, and F. Murai. Codeevolve: an open source evolutionary coding agent for algorithmic discovery and optimization. *arXiv preprint arXiv:2510.14150*, 2025.
- S. Cao, Z. Mao, J. E. Gonzalez, and I. Stoica. K-search: Llm kernel generation via co-evolving intrinsic world model. *arXiv preprint arXiv:2602.19128*, 2026.
- R. Dai, K. Huang, C. Kang, and C. Liao. It takes two to match: Co-evolving generative retriever with reinforcement learning. *arXiv preprint arXiv:2609.00638*, 2026.
- S. Du, X. Yan, J. Shi, Z. Cao, S. Feng, Z. Liang, B. Sun, T. Peng, Y. Zhou, X. Li, et al. Mlevolve: A self-evolving framework for automated machine learning algorithm discovery. *arXiv preprint arXiv:2606.06473*, 2026.
- J. H. Friedman, T. Hastie, and R. Tibshirani. Regularization paths for generalized linear models via coordinate descent. *Journal of statistical software*, 33:1–22, 2010.
- B. Georgiev, J. Gómez-Serrano, T. Tao, and A. Z. Wagner. Mathematical exploration and discovery at scale. *arXiv preprint arXiv:2511.02864*, 2025.
- S. Gupta, J. Davidson, S. Levine, R. Sukthankar, and J. Malik. Cognitive mapping and planning for visual navigation. In *Proceedings of the IEEE conference on computer vision and pattern recognition*, pages 2616–2625, 2017.
- D. Ha and J. Schmidhuber. World models. *arXiv preprint arXiv:1803.10122*, 2(3):440, 2018.
- D. Hafner, T. Lillicrap, J. Ba, and M. Norouzi. Dream to control: Learning behaviors by latent imagination. *arXiv preprint arXiv:1912.01603*, 2019.
- D. Hafner, T. Lillicrap, M. Norouzi, and J. Ba. Mastering atari with discrete world models. *arXiv preprint arXiv:2010.02193*, 2020.
- D. Hafner, J. Pasukonis, J. Ba, and T. Lillicrap. Mastering diverse domains through world models. *arXiv preprint arXiv:2301.04104*, 2023.
- D. Hafner, W. Yan, and T. Lillicrap. Training agents inside of scalable world models. *arXiv preprint arXiv:2509.24527*, 2025.
- Y. Hu, S. Liu, Y. Yue, G. Zhang, B. Liu, F. Zhu, J. Lin, H. Guo, S. Dou, Z. Xi, et al. Memory in the age of ai agents. *arXiv preprint arXiv:2512.13564*, 2025.
- C. Huang, H. Liu, T. Zheng, R. Dai, L. Huang, J. Li, Z. Li, Z. Wei, Y. Meng, and J. Huang. G-zero: Self-play for open-ended generation from zero data. *arXiv preprint arXiv:2605.09959*, 2026a.
- C. Huang, Z. Wang, R. Han, J. Yan, Y. Chen, Z. CuiZhu, K. Jiang, P. Xia, H. Yu, Y. Zhuang, et al. Envharness: Awakening static worlds for agent learning. *arXiv preprint arXiv:2608.19880*, 2026b.
- C. Huang, W. Yu, X. Wang, H. Zhang, Z. Li, R. Li, J. Huang, H. Mi, and D. Yu. R-zero: Self-evolving reasoning llm from zero data. In *International Conference on Learning Representations*, volume 2026, pages 130770–130790, 2026c.

*Page number printed: 13*

---

**[PAGE 14]**

*Layout: references continue (single column).*

- J. Jaber and O. Jaber. Autokernel: Autonomous gpu kernel optimization via iterative agent-driven search. *arXiv preprint arXiv:2603.21331*, 2026.
- J. Jiang, T. Ding, and Z. Zhu. Deltaevolve: Accelerating scientific discovery through momentum-driven evolution. *arXiv preprint arXiv:2602.02919*, 2026.
- Z. M. Kim, Y.-J. Lee, S. Jwa, and D. Kang. Meta<sup>n</sup>: Recursive self-improvement through emergent depth. *arXiv preprint arXiv:2608.24735*, 2026.
- R. Lange, Y. Imajuku, and E. Cetin. Shinkaevolve: Towards open-ended and sample-efficient program evolution. In *International Conference on Learning Representations*, volume 2026, pages 74026–74078, 2026.
- Y. Lee, R. Nair, Q. Zhang, K. Lee, O. Khattab, and C. Finn. Meta-harness: End-to-end optimization of model harnesses. *arXiv preprint arXiv:2603.28052*, 2026.
- S. Liu, S. Agarwal, M. Maheswaran, M. Cemri, Z. Li, Q. Mang, A. Naren, E. Boneh, A. Cheng, M. Z. Pan, et al. Evox: Meta-evolution for automated discovery. *arXiv preprint arXiv:2602.23413*, 2026a.
- S. Liu, M. Cemri, S. Agarwal, A. Krentsel, A. Naren, Q. Mang, Z. Li, A. Gupta, M. Maheswaran, A. Cheng, M. Pan, E. Boneh, K. Ramchandran, K. Sen, M. Zaharia, A. G. Dimakis, and I. Stoica. Skydiscover: A flexible, adaptive framework for ai-driven scientific and algorithmic discovery. In *Proceedings of the ACM Conference on AI and Agentic Systems*, CAIS ’26, pages 1223–1227. Association for Computing Machinery, 2026b. doi: 10.1145/3786335.3813221. URL `https://doi.org/10.1145/3786335.3813221`.
- S. Liu, Z. Lin, Y. Zhang, Y. Ren, Y. Wu, Y. Li, Z. Wang, Z. Fu, and J. Ye. The path to recursive self-improving agents: Foundation, framework, and future directions. *Preprints*, August 2026c. doi: 10.20944/preprints202608.0051.v1. URL `https://doi.org/10.20944/preprints202608.0051.v1`.
- T. M. Moerland, J. Broekens, A. Plaat, and C. M. Jonker. Model-based reinforcement learning: A survey. *Foundations and Trends in Machine Learning*, 16(1):1–118, 2023.
- A. Novikov, N. Vũ, M. Eisenberger, E. Dupont, P.-S. Huang, A. Z. Wagner, S. Shirobokov, B. Kozlovskii, F. J. Ruiz, A. Mehrabian, et al. Alphaevolve: A coding agent for scientific and algorithmic discovery. *arXiv preprint arXiv:2506.13131*, 2025.
- OpenAI. On the navier–stokes millennium prize problem. `https://openai.com/index/navier-stokes-solution/`, Sept. 2026. Accessed: 2026-09-10.
- A. Ouyang, S. Guo, S. Arora, A. L. Zhang, W. Hu, C. Ré, and A. Mirhoseini. Kernelbench: Can llms write efficient gpu kernels? *arXiv preprint arXiv:2502.10517*, 2025.
- S. Ouyang, J. Yan, Y. Chen, R. Han, Z. Wang, B. D. Mishra, R. Meng, C.-L. Li, Y. Jiao, K. Zha, et al. Skillos: Learning skill curation for self-evolving agents. *arXiv preprint arXiv:2605.06614*, 2026a.
- S. Ouyang, J. Yan, I. Hsu, Y. Chen, K. Jiang, Z. Wang, R. Han, L. Le, S. Daruki, X. Tang, et al. Reasoningbank: Scaling agent self-evolving with reasoning memory. In *International Conference on Learning Representations*, volume 2026, pages 94327–94354, 2026b.
- F. Pedregosa, G. Varoquaux, A. Gramfort, V. Michel, B. Thirion, O. Grisel, M. Blondel, P. Prettenhofer, R. Weiss, V. Dubourg, et al. Scikit-learn: Machine learning in python. *the Journal of machine Learning research*, 12:2825–2830, 2011.

*Page number printed: 14*

---

**[PAGE 15]**

*Layout: references continue (single column).*

- B. Romera-Paredes, M. Barekatain, A. Novikov, M. Balog, M. P. Kumar, E. Dupont, F. J. Ruiz, J. S. Ellenberg, P. Wang, O. Fawzi, et al. Mathematical discoveries from program search with large language models. *Nature*, 625(7995):468–475, 2024.
- A. Sharma. Openevolve: an open-source evolutionary coding agent, 2025. URL `https://github.com/algorithmicsuperintelligence/openevolve`.
- R. S. Sutton. Integrated architectures for learning, planning, and reacting based on approximating dynamic programming. In B. Porter and R. Mooney, editors, *Machine Learning Proceedings 1990*, pages 216–224. Morgan Kaufmann, San Francisco (CA), 1990. ISBN 978-1-55860-141-3. doi: https://doi.org/10.1016/B978-1-55860-141-3.50030-4. URL `https://www.sciencedirect.com/science/article/pii/B9781558601413500304`.
- Y. Virk, Z. Edds, C. S. Xia, and L. Zhang. Swarmresearch: Orchestrating coding agents for open-ended discovery. *arXiv preprint arXiv:2607.02807*, 2026.
- Y. Wang, S.-R. Su, Z. Zeng, E. Xu, L. Ren, X. Yang, Z. Huang, X. He, L. Ma, B. Peng, et al. Thetaevolve: Test-time learning on open problems. *arXiv preprint arXiv:2511.23473*, 2025.
- Z. Wang, M. Yan, J. Bi, S. Yan, V. Tresp, and Y. Ma. Metaskill-evolve: Recursive self-improvement of llm agents via two-timescale meta-skill evolution. *arXiv preprint arXiv:2607.05297*, 2026.
- S. Wu, C. Qian, X. Chen, and H. Ji. Teaching llms to self-evolve: Cultivating core meta-skills with reinforcement learning. *arXiv preprint arXiv:2607.21971*, 2026a.
- X. Wu, Y. Zhuan, R. Wei, H. Chen, D. Bai, J. Liu, X. Wang, X. Wang, L. Wang, and X. Cheng. Agenticrectune: Multi-agent with self-evolving skillhub for recommendation system optimization. *arXiv preprint arXiv:2604.26969*, 2026b.
- T. Xiong, Z. Yang, X. Wang, C.-C. Lin, R. Ma, K. Lin, Z. Wang, L. Li, C. Liu, R. Chen, et al. Rubrics as visual-repair context for self-evolving ui-to-code generation. *arXiv preprint arXiv:2608.24138*, 2026.
- W. Xu, A. Sordoni, C. Singh, Z. Gero, M. Galley, X. Yuan, and J. Gao. Test-time learning with an evolving library. *arXiv preprint arXiv:2605.14477*, 2026.
- M. Yan, B. Peng, B. Coleman, Z. Chen, Z. Xie, S. Chen, Z. He, N. Sachdeva, W. Wang, E. H. Chi, et al. Pacevolve++: Improving test-time learning for evolutionary search agents. *arXiv preprint arXiv:2605.07039*, 2026a.
- M. Yan, B. Peng, B. Coleman, Z. Chen, Z. Xie, S. Chen, Z. He, N. Sachdeva, I. Ye, W. Wang, et al. Pacevolve: Enabling long-horizon progress-aware consistent evolution. *arXiv preprint arXiv:2601.10657*, 2026b.
- H. Ye, H. Lin, J. Tang, Y. Luo, C. Yang, C. Su, R. Thapa, R. Yang, R. Liu, Z. Li, et al. Evaluation-driven scaling for scientific discovery. *arXiv preprint arXiv:2604.19341*, 2026.
- M. Yuksekgonul, D. Koceja, X. Li, F. Bianchi, J. McCaleb, X. Wang, J. Kautz, Y. Choi, J. Zou, C. Guestrin, et al. Learning to discover at test time. *arXiv preprint arXiv:2601.16175*, 2026.
- H. Zhang, S. Fan, H. P. Zou, Y. Chen, Z. Wang, J. Zhou, C. Li, W.-C. Huang, Y. Yao, K. Zheng, et al. Co-evoskills: Self-evolving agent skills via co-evolutionary verification. *arXiv preprint arXiv:2604.01687*, 2026a.

*Page number printed: 15*

---

**[PAGE 16]**

*Layout: five final reference entries at the top; the remaining ~65% of the page is blank.*

- J. Zhang, S. Hu, C. Lu, R. Lange, and J. Clune. Darwin gödel machine: open-ended evolution of self-improving agents. In *International Conference on Learning Representations*, volume 2026, pages 104223–104294, 2026b.
- J. Zhang, B. Zhao, W. Yang, J. Foerster, J. Clune, M. Jiang, S. Devlin, and T. Shavrina. Hyperagents. *arXiv preprint arXiv:2603.19461*, 2026c.
- Q. Zhang, C. Hu, S. Upasani, B. Ma, F. Hong, V. Kamanuru, J. Rainton, C. Wu, M. Ji, H. Li, et al. Agentic context engineering: Evolving contexts for self-improving language models. In *International Conference on Learning Representations*, volume 2026, pages 86069–86100, 2026d.
- T. Zheng, H. Liu, C. Huang, H. Bao, S. Zhang, R. Liu, R. Dai, R. Chen, C. Liu, T. Xiong, et al. Llms improving llms: Agentic discovery for test-time scaling. *arXiv preprint arXiv:2605.08083*, 2026a.
- T. Zheng, H. Zhang, W. Yu, X. Wang, H. Xing, R. Dai, R. Liu, H. Bao, C. Huang, H. Huang, et al. Parallel-r1: Towards parallel thinking via reinforcement learning. In *International Conference on Learning Representations*, volume 2026, pages 121144–121166, 2026b.

*(End of the reference list. Page otherwise blank.)*

*Page number printed: 16*

---

**[PAGE 17]**

*Layout: Appendix A heading, then three problem statements. Each problem sits in a rounded call-out box with a light-gray header bar containing a bold title ("Problem N (Name)"), and a white body with the text and centered display equations. The lower ~25% of the page is blank.*

## A. Detailed Task Description

### Problem 1 (Lasso Regularization Path)

Given a feature matrix $X \in \mathbb{R}^{n\times p}$, response $y \in \mathbb{R}^{n}$, and a decreasing sequence $\lambda_1 > \cdots > \lambda_K$, define

$$F_k(w) := \frac{1}{2n}\,\lVert y - Xw\rVert_2^2 + \lambda_k \lVert w\rVert_1, \qquad w_k^\star \in \arg\min_{w\in\mathbb{R}^p} F_k(w).$$

A candidate solver returns approximate coefficients $\widetilde{W} = (\widetilde{w}_1, \ldots, \widetilde{w}_K)$. It passes the benchmark’s objective-value check if

$$F_k(\widetilde{w}_k) \le F_k(w_{k,\mathrm{sklearn}}) + 10^{-6}, \qquad \text{for every } k,$$

where correctness is checked on fresh instances distinct from the timing instances. If any required check fails, the search score is zero.

Otherwise, letting $\mathcal{I}$ denote the timing instances and $t_i$ the time required to compute the complete regularization path on instance $i$, the search score is

$$R_{\mathrm{search}} = \left(\prod_{i\in\mathcal{I}} t_i\right)^{-1/|\mathcal{I}|}.$$

### Problem 2 (Sum–Difference Problem)

The Sum–Difference Problem asks for a finite set $A \subset \mathbb{Z}$ whose normalized sumset is large relative to its normalized difference set. The objective is

$$\Gamma(A) := \frac{\log\left(|A+A|/|A|\right)}{\log\left(|A-A|/|A|\right)},$$

where

$$A + A := \{a + a' : a, a' \in A\}, \qquad A - A := \{a - a' : a, a' \in A\}.$$

The goal is to construct a finite set $A \subset \mathbb{Z}$ that maximizes $\Gamma(A)$.

### Problem 3 (Circle Packing in a Unit Square)

For $n \in \{26, 32\}$, the circle-packing task asks for centers $(x_i, y_i) \in [0,1]^2$ and radii $r_i \ge 0$ such that every circle lies inside the unit square and no two circles overlap:

$$r_i \le x_i \le 1 - r_i, \qquad r_i \le y_i \le 1 - r_i,$$

$$(x_i - x_j)^2 + (y_i - y_j)^2 \ge (r_i + r_j)^2, \qquad 1 \le i < j \le n.$$

The objective is to maximize

$$\sum_i r_i.$$

*Page number printed: 17*

---

**[PAGE 18]**

*Layout: top of the page is the Problem 4 call-out box (same style as page 17). Below it: Appendix B heading, a short intro, B.1, and the first lines of Listing 1 in a light-gray code box with line numbers at the left. The listing is cut off at the bottom of the page (line 8) and continues on page 19.*

### Problem 4 (Autocorrelation Inequalities)

For an integrable function $f : \mathbb{R} \to \mathbb{R}$, define the autoconvolution

$$(f * f)(t) := \int_{\mathbb{R}} f(t-x)\, f(x)\, dx, \qquad t \in \left[-\tfrac{1}{2}, \tfrac{1}{2}\right].$$

**First Autocorrelation Inequality.** Find a non-negative integrable function $f : \mathbb{R} \to \mathbb{R}$ supported on $\left[-\tfrac{1}{4}, \tfrac{1}{4}\right]$ such that

$$\int_{-1/4}^{1/4} f(x)\,dx = 1.$$

The objective is to minimize

$$\Phi_1(f) := \max_{t\in[-1/2,\,1/2]} (f * f)(t).$$

**Second Autocorrelation Inequality.** Find a non-negative integrable function $f : \mathbb{R} \to \mathbb{R}$ supported on $\left[-\tfrac{1}{4}, \tfrac{1}{4}\right]$ such that

$$\int_{-1/4}^{1/4} f(x)\,dx = 1.$$

The objective is to maximize

$$\Phi_2(f) := \frac{\lVert f * f\rVert_2^2}{\lVert f * f\rVert_1\,\lVert f * f\rVert_\infty}.$$

**Third Autocorrelation Inequality.** Find an integrable (possibly signed) function $f : \mathbb{R} \to \mathbb{R}$ supported on $\left[-\tfrac{1}{4}, \tfrac{1}{4}\right]$ such that

$$\int_{-1/4}^{1/4} f(x)\,dx = 1.$$

The objective is to minimize

$$\Phi_3(f) := \max_{t\in[-1/2,\,1/2]} \left|(f * f)(t)\right|.$$

## B. Prompts

For reproducibility, we provide the prompts used for online exploration and replay-based exploration-policy improvement. Variables enclosed by dollar signs or braces are instantiated by the runtime system before execution.

### B.1. Exploration Prompt

The following prompt is used to guide the discovery agent during online exploration. It requires the agent to inspect the complete available discovery history before proposing a new solution, explicitly reason about both successful and failed attempts, and avoid repeatedly exploiting a locally saturated direction.

Listing 1 | Prompt used for online exploration.

*(Listing text is reproduced below exactly as printed, including the typeset ‘ … ‘ quote marks that stand in for backticks. Lines that wrap in the PDF are joined onto one line here; the numbers at the left are the PDF's own line numbers. Lines 9–28 appear on page 19.)*

```text
 1  You must read every historical proposal before proposing or implementing a new solution.
 2
 3  $direction_guidance
 4
 5  Variables (‘$node_dir‘, ‘$history_dir‘, ‘$baseline_dir‘, ‘$eval_program‘, ‘$problem_file‘) are filled in by the calling system. ‘$node_dir‘ is your own attempt directory -- exclude it when scanning sibling ‘attempt_*/‘ dirs.
 6
 7  ## 1. Read the complete history first
 8
```

*Page number printed: 18*

---

**[PAGE 19]**

*Layout: the code box of Listing 1 continues from the top (line 9) to the end (line 28), then B.2 begins with a prose intro and the start of Listing 2 in a second code box (lines 1–23). Listing 2 is cut off at the bottom of the page and continues on page 20, which is outside this file's range.*

*(Listing 1, continued)*

```text
 9  Before proposing anything, read every ‘proposal.md‘ under sibling ‘attempt_*/‘ dirs, ‘$history_dir‘, and ‘$baseline_dir‘ in full -- not a sample, not just recent cycles or the current branch. For each, read its matching ‘eval/score.json‘ (and ‘error.txt‘ if it failed). Trust the measured result over what the proposal claims about itself.
10
11  ## 2. Learn from both successes and failures
12
13  For every past attempt, note the mechanism and how it did. For failures, figure out *why*: a flawed core idea, or a good idea let down by a bug, bad parameters, or an implementation slip? Don’t repeat the former. The latter is worth retrying -- but only once you’ve actually located the bug in the code (not just guessed from the proposal), and only with a specific fix in hand.
14
15  ## 3. Don’t converge into a local optimum
16
17  Look at the shape of what’s been tried. If most attempts cluster around small variations of one mechanism with flattening returns, that’s a local optimum - resist proposing another small tweak there. Deliberately favor a structurally different mechanism or an untried combination over a safer marginal refinement. Exploration diversity matters as much as the next incremental gain.
18
19  ## 4. Propose and implement
20
21  The new idea must be a genuinely new mechanism, a new combination of previously-successful pieces, or a targeted fix to a specific bug found in step 2 - never a repeat or rename of something already tried. Implement it in ‘$eval_program‘. Don’t claim it compiles, is correct, or beats SOTA until it’s actually evaluated.
22
23  ## Files
24
25  Write only ‘$node_dir/proposal.md‘ (mechanism, evidence from history, why it’s not a repeat, expected benefit/risk) and ‘$node_dir/$eval_program‘. Everything else is read-only.
26
27  ## Note:
28      Never execute pkill, kill, killall, or terminate unrelated processes.
```

### B.2. Replay-Based Policy Improvement Prompt

The following prompt is used by the controller-development agent during historical replay. The agent modifies the exploration policy using feedback obtained from replay over previously collected discovery trajectories while remaining restricted to prefix-observable information.

Listing 2 | Prompt used for replay-based improvement of the exploration policy.

*(Reproduced as printed. Doubled ‘‘ … ‘‘ are the PDF's typeset stand-ins for inline-code backticks. Line 23 is an empty line at the bottom of this page; the listing continues on page 20.)*

```text
 1  You are improving one **prefix-only exploration policy**. Edit only
 2  ‘‘{method_file}‘‘ and implement ‘‘OptimalPolicy.solve(self, question, budget=None)‘‘.
 3  Do not solve the scientific task and do not edit any other program.
 4
 5  ## Objective: quality, work, and parallelism
 6
 7  The environment is a frozen, irregular branch × attempt grid. A policy opens a root
 8  or refines the next cell of an already-open branch. Each revealed cell costs one
 9  probe. The policy sees only the cells it has revealed so far; unrevealed scores are
10  unknown.
11
12  The evaluator sweeps your single ‘‘beta‘‘ knob and ranks the resulting curve by:
13
14      pareto.reward = pareto.auc - lambda * parallel_penalty
15
16  ‘‘pareto.auc‘‘ rewards reaching high per-trace attainment with few **total probes**.
17  ‘‘parallel_penalty‘‘ is the mean of
18  ‘‘effective_sequential_rounds / total_probes‘‘ over the sweep. For a batch of size
19  ‘‘k‘‘ with ‘‘W = question.max_parallelism‘‘ workers, it costs one decision round and
20  ‘‘ceil(k / W)‘‘ effective sequential rounds. A serial policy has penalty near 1;
21  useful full batches approach ‘‘1/W‘‘. Therefore choose only promising probes, but
22  batch independent promising probes whenever possible.
23
```

*(Listing 2 continues on page 20 — not included in this file.)*

*Page number printed: 19*

---

## End of DREAM_2.md

Covers PDF pages **10–19** of the 36-page `Dream-RSI.pdf`. Remaining pages **1–9** and **20–36** are not included in this file.
